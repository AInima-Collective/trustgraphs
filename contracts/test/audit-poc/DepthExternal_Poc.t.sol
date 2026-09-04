// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console} from "forge-std/Test.sol";
import {RoundPins} from "test/helpers/RoundPins.sol";

import {SP1JournalVerifier} from "src/merkle/SP1JournalVerifier.sol";
import {ISP1Verifier} from "interfaces/merkle/ISP1Verifier.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IAnchorRegistry} from "interfaces/registry/IAnchorRegistry.sol";
import {MockAccumulator} from "test/mocks/MockAccumulator.sol";

import {MerkleFundDistributor} from "src/merkle/MerkleFundDistributor.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";

import {EASIndexerResolver} from "src/eas/resolvers/EASIndexerResolver.sol";
import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {
    IEAS,
    AttestationRequest,
    AttestationRequestData,
    MultiAttestationRequest,
    RevocationRequest,
    RevocationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {NO_EXPIRATION_TIME, EMPTY_UID} from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

/*//////////////////////////////////////////////////////////////
                              HELPERS
//////////////////////////////////////////////////////////////*/

/// A "gateway" that never reverts, whatever you hand it. Models a gateway whose route was
/// mis-wired, a fork of the gateway that returns instead of reverting, or a governance mistake.
contract SilentSuccessGateway is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external view {}
}

/// A verifier for MerkleSnapshot that also exposes programVKey() and lets the deployer choose it.
contract LyingVerifier is IZkVerifier {
    bytes32 public programVKey;

    constructor(bytes32 v) {
        programVKey = v;
    }

    function verify(bytes calldata, bytes32) external view {}
}

/// A "work" anchor registry that reports whatever workCount it likes.
contract LyingWorkRegistry is IAnchorRegistry {
    bytes32 public anchorAcc;
    uint64 public anchorCount;
    uint256 private _work;

    function setState(bytes32 a, uint64 n, uint256 w) external {
        anchorAcc = a;
        anchorCount = n;
        _work = w;
    }

    function workCount() external view returns (uint256) {
        return _work;
    }
}

/// Fee recipient that refuses ETH.
contract RejectingRecipient {
    receive() external payable {
        revert("no");
    }
}

/// Minimal MerkleSnapshot stand-in for the distributor.
contract StubSnapshot {
    IMerkleSnapshot.MerkleState internal s;

    constructor() {
        s = IMerkleSnapshot.MerkleState({
            blockNumber: 1,
            timestamp: 1,
            root: keccak256("root"),
            ipfsHash: keccak256("ipfs"),
            ipfsHashCid: "cid",
            totalValue: 1000
        });
    }

    function getLatestState() external view returns (IMerkleSnapshot.MerkleState memory) {
        return s;
    }
}

contract DepthExternal_Poc is Test {
    /*//////////////////////////////////////////////////////////////
        TARGET 3 — SP1 gateway: what happens when it is not a gateway
    //////////////////////////////////////////////////////////////*/

    /// The whole soundness of `MerkleSnapshot.submitProof` rests on `gateway.verifyProof`
    /// REVERTING. `verifyProof` is declared with no return values, so solc 0.8.27 emits an
    /// `extcodesize` check. Confirm that a codeless gateway therefore fails CLOSED.
    function test_A_codelessGateway_failsClosed() public {
        address ghost = address(0xDEAD00);
        assertEq(ghost.code.length, 0, "precondition: ghost has no code");

        SP1JournalVerifier v = new SP1JournalVerifier(ISP1Verifier(ghost), keccak256("vkey"));
        // The constructor accepts a codeless gateway with no complaint at all.
        assertEq(address(v.gateway()), ghost);

        bytes memory publicValues = hex"1234";
        bytes memory proofBytes = hex"5678";
        bytes memory blob = abi.encode(publicValues, proofBytes);

        bool reverted;
        try v.verify(blob, keccak256(publicValues)) {
            reverted = false;
        } catch {
            reverted = true;
        }
        console.log("codeless gateway -> verify() reverted?", reverted);
        assertTrue(reverted, "SOUNDNESS: a codeless gateway silently accepted an arbitrary proof");
    }

    /// Same question one seam up: MerkleSnapshot.zkVerifier pointed at an address with no code.
    function test_B_codelessZkVerifier_failsClosed() public {
        MockAccumulator accer = new MockAccumulator();
        address ghost = address(0xBEEF00);
        MerkleSnapshot ms =
            new MerkleSnapshot(IZkVerifier(ghost), keccak256("params"), accer, address(this), address(this), "");

        accer.setState(keccak256("acc"), 3);
        vm.roll(100);
        uint256 id = ms.trigger();

        bool reverted;
        try ms.submitProof(id, keccak256("root"), keccak256("ipfs"), "cid", 1, bytes32(0), address(1), hex"") {
            reverted = false;
        } catch {
            reverted = true;
        }
        console.log("codeless zkVerifier -> submitProof reverted?", reverted);
        assertTrue(reverted, "SOUNDNESS: submitProof accepted a root with no verifier code");
    }

    /// A gateway that returns instead of reverting turns every "proof" into a valid one.
    /// This is what the MOCK does, which is why the test suite cannot detect it.
    function test_C_silentSuccessGateway_acceptsGarbage() public {
        SilentSuccessGateway g = new SilentSuccessGateway();
        SP1JournalVerifier v = new SP1JournalVerifier(ISP1Verifier(address(g)), keccak256("vkey"));

        MockAccumulator accer = new MockAccumulator();
        MerkleSnapshot ms = new MerkleSnapshot(v, keccak256("params"), accer, address(this), address(this), "");

        accer.setState(keccak256("acc"), 3);
        vm.roll(100);
        uint256 id = ms.trigger();

        // Attacker builds the journal the contract will compute, then hands it over as
        // publicValues with an EMPTY proof.
        IAttestationAccumulator.Checkpoint memory c = accer.getCheckpoint(id);
        bytes32 root = keccak256("attacker-root");
        bytes memory journal = abi.encode(
            c.acc,
            c.leafCount,
            bytes32(0),
            uint64(0),
            ms.checkpointParamsHash(id),
            root,
            keccak256("ipfs"),
            keccak256(bytes("cid")),
            uint256(1e24),
            bytes32(0),
            address(0xA77ACC),
            ms.instanceDomain()
        );
        bytes memory blob = abi.encode(journal, bytes(""));

        ms.submitProof(id, root, keccak256("ipfs"), "cid", 1e24, bytes32(0), address(0xA77ACC), blob);
        assertEq(ms.getLatestState().root, root, "attacker root did not land");
        console.log("silent-success gateway: arbitrary root landed with an EMPTY proof");
    }

    /// `_programVKey` is a raw staticcall that accepts any 32-byte answer, and the provenance
    /// record is what the composition layer authenticates a source by.
    function test_D_programVKey_isSelfAsserted() public {
        bytes32 fakeVKey = keccak256("the-real-trust-graph-vkey");
        LyingVerifier v = new LyingVerifier(fakeVKey);
        MockAccumulator accer = new MockAccumulator();
        MerkleSnapshot ms = new MerkleSnapshot(v, keccak256("params"), accer, address(this), address(this), "");
        ms.enableStateProvenance();

        accer.setState(keccak256("acc"), 3);
        vm.roll(100);
        uint256 id = ms.trigger();
        ms.submitProof(id, keccak256("r"), keccak256("i"), "cid", 5, bytes32(0), address(1), hex"");

        assertEq(ms.getStateProvenance(0).programVKey, fakeVKey);
        console.log("provenance recorded an attacker-chosen programVKey with a no-op verifier");
    }

    /// `_liveAnchorWork` accepts any `workCount()` >= anchorCount from a governance-set registry.
    function test_E_liveAnchorWork_acceptsInflatedWork() public {
        MockAccumulator accer = new MockAccumulator();
        LyingVerifier v = new LyingVerifier(bytes32(0));
        MerkleSnapshot ms = new MerkleSnapshot(v, keccak256("params"), accer, address(this), address(this), "");

        LyingWorkRegistry reg = new LyingWorkRegistry();
        reg.setState(keccak256("anchoracc"), 1, type(uint64).max);
        ms.setAnchorRegistry(IAnchorRegistry(address(reg)));

        accer.setState(keccak256("acc"), 1);
        vm.roll(100);
        uint256 id = ms.trigger();
        assertEq(ms.checkpointWorkCount(id), type(uint64).max);
        console.log("checkpointWorkCount pinned at uint64 max from a lying registry");
    }

    /*//////////////////////////////////////////////////////////////
              TARGET 1 — EAS <-> resolvers, real EAS 1.8.0
    //////////////////////////////////////////////////////////////*/

    EAS internal eas;
    SchemaRegistry internal registry;

    function _bootEas() internal {
        registry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(registry)));
    }

    function _attest(bytes32 schema, address to, uint64 expiry) internal returns (bytes32) {
        AttestationRequestData memory d = AttestationRequestData({
            recipient: to, expirationTime: expiry, revocable: true, refUID: EMPTY_UID, data: hex"01", value: 0
        });
        return eas.attest(AttestationRequest({schema: schema, data: d}));
    }

    /// EAS lets `attestByDelegation`'s relayer be anyone; the fold books `attestation.attester`.
    /// Also: does the resolver see a revoke for a schema it is not bound to? (EAS blocks it.)
    function test_F_revokeWithWrongSchema_isBlockedByEAS() public {
        _bootEas();
        EASIndexerResolver r1 = new EASIndexerResolver(IEAS(address(eas)));
        EASIndexerResolver r2 = new EASIndexerResolver(IEAS(address(eas)));
        bytes32 s1 = registry.register("uint256 a", r1, true);
        bytes32 s2 = registry.register("uint256 a", r2, true);
        r1.bindSchema(s1);
        r2.bindSchema(s2);

        bytes32 uid = _attest(s1, address(0xAA), NO_EXPIRATION_TIME);

        // Revoking uid under s2 must fail inside EAS before r2 ever sees it.
        vm.expectRevert();
        eas.revoke(RevocationRequest({schema: s2, data: RevocationRequestData({uid: uid, value: 0})}));
        assertEq(r2.leafCount(), 0, "foreign revoke reached the wrong accumulator");
    }

    /// Re-attesting the identical edge after a revoke produces a NEW uid (EAS bumps), so the
    /// accumulator grows by 2 leaves per vouch/unvouch cycle, forever, at attacker choice.
    function test_G_revokeReattestCycle_growsAccumulatorUnbounded() public {
        _bootEas();
        EASIndexerResolver r = new EASIndexerResolver(IEAS(address(eas)));
        bytes32 s = registry.register("uint256 a", r, true);
        r.bindSchema(s);

        for (uint256 i = 0; i < 5; i++) {
            bytes32 uid = _attest(s, address(0xAA), NO_EXPIRATION_TIME);
            eas.revoke(RevocationRequest({schema: s, data: RevocationRequestData({uid: uid, value: 0})}));
        }
        console.log("leafCount after 5 vouch/unvouch cycles by ONE account:", r.leafCount());
        assertEq(r.leafCount(), 10);
    }

    /// The resolver rejects expiration because time passing cannot append a revocation leaf.
    function test_H_nonzeroExpirationIsRejected() public {
        _bootEas();
        EASIndexerResolver r = new EASIndexerResolver(IEAS(address(eas)));
        bytes32 s = registry.register("uint256 a", r, true);
        r.bindSchema(s);

        uint64 exp = uint64(block.timestamp + 1 days);
        vm.expectRevert(abi.encodeWithSelector(EASIndexerResolver.ExpirationNotSupported.selector, exp));
        _attest(s, address(0xAA), exp);
        assertEq(r.acc(), bytes32(0), "expiring edge reached the accumulator");
        assertEq(r.leafCount(), 0);
    }

    /// Anything but EAS reaching onAttest/onRevoke.
    function test_J_onlyEasCanReachResolver() public {
        _bootEas();
        EASIndexerResolver r = new EASIndexerResolver(IEAS(address(eas)));
        bytes32 s = registry.register("uint256 a", r, true);
        r.bindSchema(s);

        // The SchemaResolver.attest entrypoint is onlyEAS.
        (bool ok,) = address(r)
            .call(
                abi.encodeWithSignature(
                    "attest((bytes32,bytes32,uint64,uint64,uint64,bytes32,address,address,bool,bytes))", bytes32(0)
                )
            );
        assertFalse(ok, "a stranger reached the resolver's attest entrypoint");
        assertEq(r.leafCount(), 0);
    }

    /*//////////////////////////////////////////////////////////////
       TARGET 5 — native ETH recipients in MerkleFundDistributor
    //////////////////////////////////////////////////////////////*/

    function test_K_revertingFeeRecipient_blocksEveryNativeRound() public {
        StubSnapshot snap = new StubSnapshot();
        RejectingRecipient bad = new RejectingRecipient();
        // 1% fee, fee recipient refuses ETH.
        MerkleFundDistributor d = new MerkleFundDistributor(address(this), address(snap), address(bad), 1e16, false);

        vm.deal(address(this), 10 ether);
        RoundPins.Pins memory _pins0 = RoundPins.read(d, 1 ether);
        vm.expectRevert();
        d.distribute{value: 1 ether}(
            address(0), 1 ether, _pins0.root, _pins0.totalValue, 0, type(uint256).max, _pins0.feeRecipient
        );

        // ERC20 rounds are equally blocked (SafeERC20 bubbles the callee revert), but the
        // decisive point is that ONE owner-set address halts every native funding round for
        // every funder until the owner fixes it.
        console.log("native distribute() reverts while feeRecipient refuses ETH");
    }
}
