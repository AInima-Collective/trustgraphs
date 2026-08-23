// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {CompositionSourceAdapter, CompositionSourceAdapterFactory} from "src/composition/CompositionSourceAdapter.sol";
import {CompositionSourceAccumulator} from "src/composition/CompositionSourceAccumulator.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {ProvingVault} from "src/vault/ProvingVault.sol";
import {TestUSDC} from "src/tokens/TestUSDC.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {MockAccumulator} from "../../mocks/MockAccumulator.sol";
import {MockEthUsdFeed} from "../../mocks/MockEthUsdFeed.sol";

contract PassAVerifier is IZkVerifier {
    bytes32 public immutable programVKey;

    constructor(bytes32 k) {
        programVKey = k;
    }

    function verify(bytes calldata, bytes32) external pure {}
}

/// @notice H-6 regression using the production composition accumulator: claims use each named
///         checkpoint's accepted state and accumulator even while compose leaf counts stay flat.
contract OmegaPassA_VaultClaimStatement is Test {
    bytes32 internal constant SOURCE_PROGRAM = keccak256("trust-graph");
    bytes32 internal constant COMPOSE_PROGRAM = keccak256("trust-compose");
    bytes32 internal constant FAMILY = keccak256("family-v1");
    bytes32 internal constant ALLOCATION = keccak256("allocation");
    bytes32 internal constant SOURCE_VKEY = keccak256("source-vkey");
    bytes32 internal constant COMPOSE_PARAMS = keccak256("compose-params");
    bytes32 internal constant COMPOSE_INSTANCE = keccak256("compose-instance");

    InstanceRegistry internal registry;
    CompositionSourceAdapterFactory internal adapterFactory;
    PassAVerifier internal sourceVerifier;
    PassAVerifier internal composeVerifier;
    address[] internal adapters;

    CompositionSourceAccumulator internal accumulator;
    MerkleSnapshot internal snapshot;
    ProvingVault internal vault;
    TestUSDC internal usdc;
    MockEthUsdFeed internal feed;

    address internal proverA = address(0xA1);
    address internal proverB = address(0xB2);

    function setUp() public {
        registry = new InstanceRegistry(address(this));
        adapterFactory = new CompositionSourceAdapterFactory(registry);
        sourceVerifier = new PassAVerifier(SOURCE_VKEY);
        composeVerifier = new PassAVerifier(keccak256("compose-vkey"));
        _createSource(0);
        _createSource(1);

        accumulator = new CompositionSourceAccumulator(adapterFactory, address(this));
        snapshot = new MerkleSnapshot(composeVerifier, COMPOSE_PARAMS, accumulator, address(this), address(this));
        snapshot.enableStateProvenance();
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

        // Fund the tank and enable payouts with NO cadence gate.
        vm.deal(address(this), 100 ether);
        vault.depositETH{value: 10 ether}(COMPOSE_INSTANCE);
        vault.setPolicy(COMPOSE_INSTANCE, 0, uint96(50 * vault.USD()));
    }

    receive() external payable {}

    function test_PassA_ComposeLeafCountIsConstantAcrossCheckpoints() public {
        vm.roll(100);
        uint256 c0 = snapshot.trigger();
        vm.roll(101);
        uint256 c1 = snapshot.trigger();

        assertEq(accumulator.getCheckpoint(c0).leafCount, accumulator.getCheckpoint(c1).leafCount, "leafCount moved");
        assertTrue(accumulator.getCheckpoint(c0).acc != accumulator.getCheckpoint(c1).acc, "acc identical");
        assertEq(snapshot.checkpointWorkCount(c0), 0);
        assertEq(snapshot.checkpointWorkCount(c1), 0);
    }

    function test_PassA_ClaimOlderFirstPreservesBothBounties() public {
        vm.roll(100);
        uint256 c0 = snapshot.trigger();
        snapshot.submitProof(c0, keccak256("root-0"), bytes32(uint256(1)), "cid0", 1_000, bytes32(0), proverA, "");

        vm.roll(101);
        uint256 c1 = snapshot.trigger();
        snapshot.submitProof(c1, keccak256("root-1"), bytes32(uint256(2)), "cid1", 2_000, bytes32(0), proverB, "");

        // Both roots are on chain; both name a distinct payee. Two bounties are owed.
        assertEq(snapshot.checkpointRecipient(c0), proverA);
        assertEq(snapshot.checkpointRecipient(c1), proverB);

        uint256 feeA = vault.claim(COMPOSE_INSTANCE, c0);
        assertGt(feeA, 0, "prover A unpaid");
        assertGt(vault.creditOf(proverA, address(0)), 0);

        vault.claim(COMPOSE_INSTANCE, c1);

        assertGt(vault.creditOf(proverB, address(0)), 0, "prover B paid");
        assertTrue(vault.isClaimed(COMPOSE_INSTANCE, c1));
    }

    function test_PassA_ClaimNewestFirstPreservesBothBounties() public {
        vm.roll(100);
        uint256 c0 = snapshot.trigger();
        snapshot.submitProof(c0, keccak256("root-0"), bytes32(uint256(1)), "cid0", 1_000, bytes32(0), proverA, "");
        vm.roll(101);
        uint256 c1 = snapshot.trigger();
        snapshot.submitProof(c1, keccak256("root-1"), bytes32(uint256(2)), "cid1", 2_000, bytes32(0), proverB, "");

        vault.claim(COMPOSE_INSTANCE, c1);
        assertGt(vault.creditOf(proverB, address(0)), 0);

        vault.claim(COMPOSE_INSTANCE, c0);
        assertGt(vault.creditOf(proverA, address(0)), 0, "prover A paid");
    }

    /*//////////////////////////////////////////////////////////////
                                 FIXTURE
    //////////////////////////////////////////////////////////////*/

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
                    uint64(500),
                    uint8(1)
                )
            );
        }
    }
}
