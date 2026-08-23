// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {CompositionSourceAdapter, CompositionSourceAdapterFactory} from "src/composition/CompositionSourceAdapter.sol";
import {CompositionSourceAccumulator} from "src/composition/CompositionSourceAccumulator.sol";
import {AttestationAccumulator} from "src/eas/AttestationAccumulator.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {ProvingVault} from "src/vault/ProvingVault.sol";
import {TestUSDC} from "src/tokens/TestUSDC.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {MockAccumulator} from "../../mocks/MockAccumulator.sol";
import {MockEthUsdFeed} from "../../mocks/MockEthUsdFeed.sol";

contract VerifyVerifier is IZkVerifier {
    bytes32 public immutable programVKey;

    constructor(bytes32 k) {
        programVKey = k;
    }

    function verify(bytes calldata, bytes32) external pure {}
}

/// Thin concrete wrapper over the REAL `AttestationAccumulator` mixin (the trust-graph lane-1
/// feeder that `EASIndexerResolver` inherits), so the fold/leafCount relationship can be exercised
/// without standing up EAS.
contract RealLaneOne is AttestationAccumulator {
    function fold(bytes32 uid) external {
        _fold(0, msg.sender, msg.sender, uid, keccak256(abi.encode(uid)));
    }
}

/// @title VerifyVaultC4
/// @notice Adjudication-tier verification of C4 / C17 against the REAL composition stack
///         (`CompositionSourceAccumulator`, `CompositionSourceAdapterFactory`,
///         `CompositionSourceAdapter`, `MerkleSnapshot`, `InstanceRegistry`, `ProvingVault`),
///         wired the way `TrustComposeFactory.createInstance` wires it: provenance enabled on the
///         compose snapshot, a nonzero epoch schedule, and NO anchor registry.
contract VerifyVaultC4 is Test {
    bytes32 internal constant SOURCE_PROGRAM = keccak256("trust-graph");
    bytes32 internal constant COMPOSE_PROGRAM = keccak256("trust-compose");
    bytes32 internal constant FAMILY = keccak256("family-v1");
    bytes32 internal constant ALLOCATION = keccak256("allocation");
    bytes32 internal constant COMPOSE_PARAMS = keccak256("compose-params");
    bytes32 internal constant COMPOSE_INSTANCE = keccak256("compose-instance");

    uint64 internal constant EPOCH = 100; // models TrustComposeFactory's EPOCH_FLOOR

    InstanceRegistry internal registry;
    CompositionSourceAdapterFactory internal adapterFactory;
    VerifyVerifier internal sourceVerifier;
    VerifyVerifier internal composeVerifier;
    address[] internal adapters;

    CompositionSourceAccumulator internal accumulator;
    MerkleSnapshot internal snapshot;
    ProvingVault internal vault;
    TestUSDC internal usdc;
    MockEthUsdFeed internal feed;

    address internal proverA = address(0xA1);
    address internal proverB = address(0xB2);
    address internal griefer = address(0x6417);

    receive() external payable {}

    function setUp() public {
        registry = new InstanceRegistry(address(this));
        adapterFactory = new CompositionSourceAdapterFactory(registry);
        sourceVerifier = new VerifyVerifier(keccak256("source-vkey"));
        composeVerifier = new VerifyVerifier(keccak256("compose-vkey"));
        _createSource(0);
        _createSource(1);

        accumulator = new CompositionSourceAccumulator(adapterFactory, address(this));
        snapshot = new MerkleSnapshot(composeVerifier, COMPOSE_PARAMS, accumulator, address(this), address(this));
        // Exactly what TrustComposeFactory.createInstance does, in order.
        snapshot.enableStateProvenance();
        snapshot.setEpochLength(EPOCH);
        accumulator.bind(address(snapshot), address(this));
        accumulator.installPolicy(1, _policy(), adapters);

        registry.registerWithParamsAuthority(
            COMPOSE_INSTANCE,
            IInstanceRegistry.Instance({
                program: COMPOSE_PROGRAM,
                snapshot: address(snapshot),
                verifier: address(composeVerifier),
                registryOrAccumulator: address(accumulator),
                paramsHash: COMPOSE_PARAMS
            }),
            address(this)
        );

        usdc = new TestUSDC();
        feed = new MockEthUsdFeed();
        vault = new ProvingVault(registry, usdc, feed, 1 hours, 100e8, 100_000e8, address(this), address(this));
        vault.setFeePerRootUsd(COMPOSE_PROGRAM, 3, 10 * vault.USD());

        vm.warp(1_000_000);
        vm.fee(1 gwei);
        feed.set(3_000e8, block.timestamp);

        vm.deal(address(this), 100 ether);
        vault.depositETH{value: 10 ether}(COMPOSE_INSTANCE);
        vault.setPolicy(COMPOSE_INSTANCE, 0, uint96(50 * vault.USD()));
    }

    /*//////////////////////////////////////////////////////////////
      C17 — the anti-spam guard cannot fire on a real compose instance
    //////////////////////////////////////////////////////////////*/

    function test_V0_ComposeAccMovesEveryBlockAndLeafCountNeverDoes() public {
        vm.roll(1_000);
        uint256 c0 = snapshot.trigger();
        vm.roll(1_100);
        uint256 c1 = snapshot.trigger();
        vm.roll(1_200);
        uint256 c2 = snapshot.trigger();

        // No source published, no policy rotated, nothing at all moved between the three triggers.
        assertTrue(accumulator.getCheckpoint(c0).acc != accumulator.getCheckpoint(c1).acc);
        assertTrue(accumulator.getCheckpoint(c1).acc != accumulator.getCheckpoint(c2).acc);
        assertEq(accumulator.getCheckpoint(c0).leafCount, 2);
        assertEq(accumulator.getCheckpoint(c1).leafCount, 2);
        assertEq(accumulator.getCheckpoint(c2).leafCount, 2);
        // No anchor registry is ever installed by TrustComposeFactory.
        assertEq(address(snapshot.anchorRegistry()), address(0));
        assertEq(snapshot.checkpointWorkCount(c0), 0);
        assertEq(snapshot.checkpointWorkCount(c2), 0);
    }

    function test_V1_UnchangedSourcesProduceDistinctAccumulatorBoundStatements() public {
        bytes32 R = keccak256("composed-allocation");

        vm.roll(1_000);
        uint256 c0 = snapshot.trigger();
        vm.prank(proverA);
        vault.submitAndClaim(COMPOSE_INSTANCE, _args(c0, R, proverA));
        assertGt(vault.creditOf(proverA, address(0)), 0, "epoch 0 paid");

        // Next epoch. No source moved, so the composed allocation is byte-identical (the capture
        // block enters the TGCM digest but never the output blob: composition-core uses
        // capture_block only for the freshness comparison).
        vm.roll(1_100);
        uint256 c1 = snapshot.trigger();

        vm.prank(proverB);
        vault.submitAndClaim(COMPOSE_INSTANCE, _args(c1, R, proverB));

        assertEq(snapshot.lastAppliedCheckpoint(), c1, "verified root remained applied");
        assertGt(vault.creditOf(proverB, address(0)), 0, "prover B paid for distinct proof work");
    }

    function test_V1b_PolicyStateDoesNotChangeWhetherRepeatedOutputLands() public {
        bytes32 R = keccak256("composed-allocation");

        vm.roll(1_000);
        uint256 c0 = snapshot.trigger();
        vm.prank(proverA);
        vault.submitAndClaim(COMPOSE_INSTANCE, _args(c0, R, proverA));

        // With policy off the root lands unpaid.
        vault.setPolicy(COMPOSE_INSTANCE, 0, 0);
        vm.roll(1_100);
        uint256 c1 = snapshot.trigger();
        vm.prank(proverB);
        vault.submitAndClaim(COMPOSE_INSTANCE, _args(c1, R, proverB));
        assertEq(snapshot.lastAppliedCheckpoint(), c1, "unfunded/disabled: the repeat root lands");

        // With policy back on a new accumulator-bound proof lands and pays.
        vault.setPolicy(COMPOSE_INSTANCE, 0, uint96(50 * 1e8));
        vm.roll(1_200);
        uint256 c2 = snapshot.trigger();
        vm.prank(proverB);
        vault.submitAndClaim(COMPOSE_INSTANCE, _args(c2, R, proverB));
        assertEq(snapshot.lastAppliedCheckpoint(), c2, "paying: the repeat output still lands");
        assertGt(vault.creditOf(proverB, address(0)), 0, "paying policy credits distinct proof");
    }

    function test_V2_ClaimOfOldCheckpointCannotBurnNewestBounty() public {
        vm.roll(1_000);
        uint256 c0 = snapshot.trigger();
        snapshot.submitProof(c0, keccak256("root-0"), bytes32(uint256(1)), "cid0", 1_000, bytes32(0), proverA, "");
        vm.roll(1_100);
        uint256 c1 = snapshot.trigger();
        snapshot.submitProof(c1, keccak256("root-1"), bytes32(uint256(2)), "cid1", 2_000, bytes32(0), proverB, "");

        // A stranger, paying nothing but gas, settles the OLD checkpoint.
        vm.prank(griefer);
        vault.claim(COMPOSE_INSTANCE, c0);
        assertGt(vault.creditOf(proverA, address(0)), 0);
        assertEq(vault.creditOf(griefer, address(0)), 0, "the griefer gains nothing");

        vault.claim(COMPOSE_INSTANCE, c1);
        assertTrue(vault.isClaimed(COMPOSE_INSTANCE, c1));
        assertGt(vault.creditOf(proverB, address(0)), 0);
    }

    /*//////////////////////////////////////////////////////////////
      C4 (c) — is a SINGLE proof ever paid twice? Sharpening the
      "double payment" claim: the two paid claims correspond to two
      DIFFERENT journal digests, i.e. two distinct SP1 proofs.
    //////////////////////////////////////////////////////////////*/

    function test_V3_TwoPaymentsAreForTwoDistinctJournalsNotOneProofTwice() public {
        bytes32 R0 = keccak256("root-0");

        vm.roll(1_000);
        uint256 c0 = snapshot.trigger();
        snapshot.submitProof(c0, R0, bytes32(uint256(1)), "cid", 1_000, bytes32(0), proverA, "");
        vm.roll(1_100);
        uint256 c1 = snapshot.trigger();
        snapshot.submitProof(c1, keccak256("root-1"), bytes32(uint256(2)), "cid", 1_000, bytes32(0), proverB, "");

        // Settle c0 while c1's root is latest; c0 still uses its own accepted state.
        vault.claim(COMPOSE_INSTANCE, c0);

        // A later checkpoint reproduces c0's output but has a different accumulator, so it is a
        // different journal and legitimately earns another payment.
        vm.roll(1_200);
        uint256 c2 = snapshot.trigger();
        snapshot.submitProof(c2, R0, bytes32(uint256(1)), "cid", 1_000, bytes32(0), proverA, "");

        uint256 before = vault.creditOf(proverA, address(0));
        vault.claim(COMPOSE_INSTANCE, c2);
        assertGt(vault.creditOf(proverA, address(0)), before, "statement (2,0,R0) paid a second time");

        // But the two payments bought two DIFFERENT proofs: the journal binds the checkpoint's
        // `acc`, which the compose capture makes unique per block. No single proof was reused.
        assertTrue(
            accumulator.getCheckpoint(c0).acc != accumulator.getCheckpoint(c2).acc,
            "the two paid checkpoints share an input commitment"
        );
        assertTrue(_journal(c0, R0, proverA) != _journal(c2, R0, proverA), "same journal digest");
    }

    /*//////////////////////////////////////////////////////////////
      REFUTATION ATTEMPT — the collision is structurally impossible on
      a plain trust-graph lane-1 accumulator, because `_fold` moves
      `acc` and `leafCount` together.
    //////////////////////////////////////////////////////////////*/

    function test_V4_TrustGraphLaneOneCannotProduceEqualLeafCountsAcrossCheckpoints() public {
        RealLaneOne lane = new RealLaneOne();
        MerkleSnapshot snap = new MerkleSnapshot(sourceVerifier, keccak256("p"), lane, address(this), address(this));
        lane.bindSnapshot(address(snap));

        vm.roll(2_000);
        lane.fold(keccak256("e0"));
        uint256 k0 = snap.trigger();
        vm.roll(2_100);
        lane.fold(keccak256("e1"));
        uint256 k1 = snap.trigger();

        assertEq(lane.getCheckpoint(k0).leafCount, 1);
        assertEq(lane.getCheckpoint(k1).leafCount, 2);

        // Without a fold, `acc` is unchanged and `trigger()` fails closed: there is no way to mint
        // two lane-1 checkpoints that share a leafCount.
        vm.roll(2_200);
        vm.expectRevert(IAttestationAccumulator.NoNewInputs.selector);
        snap.trigger();
    }

    /*//////////////////////////////////////////////////////////////
                                 FIXTURE
    //////////////////////////////////////////////////////////////*/

    function _journal(uint256 cp, bytes32 root, address recipient) internal view returns (bytes32) {
        IAttestationAccumulator.Checkpoint memory c = accumulator.getCheckpoint(cp);
        return keccak256(
            abi.encode(
                c.acc,
                c.leafCount,
                bytes32(0),
                uint64(0),
                snapshot.checkpointParamsHash(cp),
                root,
                bytes32(uint256(1)),
                keccak256(bytes("cid")),
                uint256(1_000),
                bytes32(0),
                recipient,
                snapshot.instanceDomain()
            )
        );
    }

    function _args(uint256 cp, bytes32 root, address recipient)
        internal
        pure
        returns (IProvingVault.SubmitArgs memory a)
    {
        a.checkpointId = cp;
        a.outputRoot = root;
        a.ipfsHash = bytes32(uint256(1));
        a.ipfsHashCid = "cid";
        a.totalValue = 1_000;
        a.skippedDigest = bytes32(0);
        a.recipient = recipient;
        a.proof = "";
        a.minPayoutUsd = 0; // "land it regardless of payment"
    }

    function _createSource(uint256 index) internal {
        MockAccumulator sourceAccumulator = new MockAccumulator();
        bytes32 paramsHash = keccak256(abi.encode("source params", index));
        MerkleSnapshot sourceSnapshot =
            new MerkleSnapshot(sourceVerifier, paramsHash, sourceAccumulator, address(this), address(this));
        sourceSnapshot.enableStateProvenance();
        bytes32 instanceId = bytes32(index + 1);
        registry.registerWithParamsAuthority(
            instanceId,
            IInstanceRegistry.Instance({
                program: SOURCE_PROGRAM,
                snapshot: address(sourceSnapshot),
                verifier: address(sourceVerifier),
                registryOrAccumulator: address(sourceAccumulator),
                paramsHash: paramsHash
            }),
            address(this)
        );
        sourceAccumulator.setState(keccak256(abi.encode("edge", index)), uint64(index + 1));
        vm.roll(10 + index);
        uint256 checkpoint = sourceSnapshot.trigger();
        sourceSnapshot.submitProof(
            checkpoint,
            keccak256(abi.encode("source root", index)),
            sha256(abi.encode("blob", index)),
            string.concat("bafk-src-", vm.toString(index)),
            1_000 + index,
            bytes32(0),
            address(0),
            ""
        );
        CompositionSourceAdapter adapter = adapterFactory.create(
            registry, instanceId, bytes32(index + 1), FAMILY, ALLOCATION, keccak256(abi.encode("provenance", index))
        );
        adapters.push(address(adapter));
    }

    function _policy() internal view returns (bytes memory manifest) {
        manifest = abi.encodePacked(bytes4("TGCP"), uint16(1), uint64(block.chainid), uint8(2));
        for (uint256 i; i < 2; ++i) {
            CompositionSourceAdapter adapter = CompositionSourceAdapter(adapters[i]);
            manifest = bytes.concat(
                manifest,
                abi.encodePacked(
                    adapter.sourceId(),
                    adapter.snapshot(),
                    adapter.familyId(),
                    SOURCE_PROGRAM,
                    uint64(5e17),
                    uint64(5_000),
                    uint8(1)
                )
            );
        }
    }
}
