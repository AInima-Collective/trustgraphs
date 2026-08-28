// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// plamen methodology PoC — Trustgraphs pre-testnet audit.
// Disposable: this whole directory is deleted after the audit.

import {Test, Vm} from "forge-std/Test.sol";

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";
import {Enum} from "@gnosis.pm/safe-contracts/common/Enum.sol";
import {Operation} from "@gnosis-guild/zodiac-core/core/Operation.sol";

import {MerkleGovModule} from "src/zodiac/MerkleGovModule.sol";
import {DelayedRecoveryModule} from "src/zodiac/DelayedRecoveryModule.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {EASIndexerResolver} from "src/eas/resolvers/EASIndexerResolver.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IMerkleSnapshotHook} from "interfaces/merkle/IMerkleSnapshotHook.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";

import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaResolver} from "@ethereum-attestation-service/eas-contracts/contracts/resolver/ISchemaResolver.sol";
import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import {
    AttestationRequest,
    AttestationRequestData
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

/*//////////////////////////////////////////////////////////////
                              MOCKS
//////////////////////////////////////////////////////////////*/

contract PlamenMockSnapshot is IMerkleSnapshot {
    MerkleState private _latest;
    bool private _hasState;

    function setLatestState(MerkleState memory s) external {
        _latest = s;
        _hasState = true;
    }

    function getLatestState() external view override returns (MerkleState memory) {
        if (!_hasState) revert IMerkleSnapshot.NoMerkleStates();
        return _latest;
    }

    function pushUpdate(address hook) external {
        IMerkleSnapshotHook(hook).onMerkleUpdate(_latest);
    }
}

contract PlamenTarget {
    uint256 public value;

    function setValue(uint256 v) external {
        value = v;
    }
}

contract PlamenAcceptAllVerifier is IZkVerifier {
    function verify(bytes calldata, bytes32) external view {}
}

/*//////////////////////////////////////////////////////////////
                              TESTS
//////////////////////////////////////////////////////////////*/

contract PlamenGovAndBind is Test {
    GnosisSafe internal safeSingleton;
    GnosisSafeProxyFactory internal safeFactory;
    GnosisSafe internal safe;
    MerkleGovModule internal gov;
    PlamenMockSnapshot internal snap;

    address internal creator = address(0xC0FFEE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    // 2-leaf tree over (alice, 100e18) and (bob, 200e18)
    bytes32 internal leafAlice;
    bytes32 internal leafBob;
    bytes32 internal root;
    uint256 internal constant TOTAL = 300e18;

    function _leaf(address a, uint256 v) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a, v))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function setUp() public {
        safeSingleton = new GnosisSafe();
        safeFactory = new GnosisSafeProxyFactory();

        address[] memory owners = new address[](1);
        owners[0] = creator;
        bytes memory setupData = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners,
            uint256(1),
            address(0),
            "",
            address(0),
            address(0),
            uint256(0),
            address(0)
        );
        safe = GnosisSafe(
            payable(address(safeFactory.createProxyWithNonce(address(safeSingleton), setupData, uint256(1))))
        );

        leafAlice = _leaf(alice, 100e18);
        leafBob = _leaf(bob, 200e18);
        root = _pair(leafAlice, leafBob);

        snap = new PlamenMockSnapshot();
        snap.setLatestState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: root,
                ipfsHash: bytes32(uint256(1)),
                ipfsHashCid: "ipfs://x",
                totalValue: TOTAL
            })
        );

        // Mirrors GovernedTrustgraphsFactory: owner == avatar == target == the Safe.
        gov = new MerkleGovModule(address(safe), address(safe), address(safe), address(snap));
        vm.prank(address(safe));
        safe.enableModule(address(gov));
        vm.deal(address(safe), 100 ether);
    }

    function _proofFor(address who) internal view returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = who == alice ? leafBob : leafAlice;
    }

    /*//////////////////////////////////////////////////////////////
      P-1  A passed proposal expires after its snapshotted execution
           window, including across a complete turnover of the score
           root that granted its mandate.
    //////////////////////////////////////////////////////////////*/
    function test_P1_PassedProposalExpiresAfterFullRootTurnover() public {
        PlamenTarget t = new PlamenTarget();

        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory datas = new bytes[](1);
        Operation[] memory ops = new Operation[](1);
        string[] memory descs = new string[](1);
        targets[0] = address(t);
        values[0] = 0;
        datas[0] = abi.encodeCall(PlamenTarget.setValue, (42));
        ops[0] = Operation.Call;
        descs[0] = "set";

        vm.prank(bob);
        uint256 id = gov.propose("t", "d", targets, values, datas, ops, descs, 200e18, _proofFor(bob));

        vm.roll(block.number + gov.votingDelay() + 1);
        vm.prank(bob);
        gov.castVote(id, MerkleGovModule.VoteType.Yes, 200e18, _proofFor(bob));

        vm.roll(_endBlock(id) + 1);
        assertEq(uint256(gov.state(id)), uint256(MerkleGovModule.ProposalState.Passed), "should be Passed");

        // The entire membership turns over: a brand-new root in which NEITHER alice nor bob
        // has any voting power at all. Governance's mandate is gone.
        bytes32 newRoot = _leaf(address(0xDEAD), 1e18);
        snap.setLatestState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: newRoot,
                ipfsHash: bytes32(uint256(2)),
                ipfsHashCid: "ipfs://y",
                totalValue: 1e18
            })
        );
        snap.pushUpdate(address(gov));
        assertEq(gov.currentMerkleRoot(), newRoot, "root rotated");

        // Two years of blocks later the stale proposal is expired and inert.
        vm.roll(block.number + 5_000_000);
        assertEq(uint256(gov.state(id)), uint256(MerkleGovModule.ProposalState.Expired), "not Expired after 2 years");

        vm.expectRevert(MerkleGovModule.ProposalNotPassed.selector);
        gov.execute(id);
        assertEq(t.value(), 0, "stale proposal executed against the Safe long after its root died");
    }

    function _endBlock(uint256 id) internal view returns (uint256) {
        (MerkleGovModule.Proposal memory p,,) = gov.getProposal(id);
        return p.endBlock;
    }

    /*//////////////////////////////////////////////////////////////
      P-2  A "member-governed" Safe has NO member governance before
           its first proven root, and none again if the graph is ever
           fully revoked — while the creator's DelayedRecoveryModule
           remains a live, unilateral, arbitrary-action route.
    //////////////////////////////////////////////////////////////*/
    function test_P2_NoRootMeansNoGovernance_ButRecoveryStillOwnsTheSafe() public {
        // A fresh instance whose snapshot has never accepted a root.
        PlamenMockSnapshot fresh = new PlamenMockSnapshot();

        address[] memory owners = new address[](1);
        owners[0] = creator;
        GnosisSafe s2 = GnosisSafe(
            payable(address(
                    safeFactory.createProxyWithNonce(
                        address(safeSingleton),
                        abi.encodeWithSignature(
                            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
                            owners,
                            uint256(1),
                            address(0),
                            "",
                            address(0),
                            address(0),
                            uint256(0),
                            address(0)
                        ),
                        uint256(2)
                    )
                ))
        );

        MerkleGovModule g2 = new MerkleGovModule(address(s2), address(s2), address(s2), address(fresh));
        DelayedRecoveryModule rec = new DelayedRecoveryModule(address(s2), creator, 14 days);

        vm.startPrank(address(s2));
        s2.enableModule(address(g2));
        s2.enableModule(address(rec));
        vm.stopPrank();
        vm.deal(address(s2), 10 ether);

        // (a) Member governance is impossible: no root, so `propose` fails at the door.
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory datas = new bytes[](1);
        Operation[] memory ops = new Operation[](1);
        string[] memory descs = new string[](1);
        targets[0] = address(0x1234);
        values[0] = 0;
        datas[0] = "";
        ops[0] = Operation.Call;
        descs[0] = "";
        bytes32[] memory emptyProof = new bytes32[](0);

        vm.prank(alice);
        vm.expectRevert(MerkleGovModule.NoMerkleRootSet.selector);
        g2.propose("t", "d", targets, values, datas, ops, descs, 1, emptyProof);

        // (b) The creator's recovery route is live and unilateral. It can queue ANY action,
        //     including one that drains the Safe, and after the delay ANYONE can fire it.
        address thief = address(0xBEEF);
        vm.prank(creator);
        rec.schedule(thief, 10 ether, "", Enum.Operation.Call);

        vm.warp(block.timestamp + 14 days + 1);
        rec.execute(0, thief, 10 ether, "", Enum.Operation.Call);

        assertEq(thief.balance, 10 ether, "creator drained a 'member-governed' Safe with no member able to object");
        assertEq(address(s2).balance, 0);
    }

    /*//////////////////////////////////////////////////////////////
      P-3  MerkleSnapshot.addHook / removeHook are constitutional
           state changes that emit NO event at all. The Ponder indexer
           rebuilds protocol state from events, so the set of consumers
           receiving proven roots is invisible off-chain.
    //////////////////////////////////////////////////////////////*/
    function test_P3_AddRemoveHookEmitNoEvents() public {
        PlamenAcceptAllVerifier v = new PlamenAcceptAllVerifier();
        PlamenAccumulatorStub accStub = new PlamenAccumulatorStub();
        address admin = address(this);

        MerkleSnapshot ms = new MerkleSnapshot(
            IZkVerifier(address(v)), bytes32(uint256(1)), IAttestationAccumulator(address(accStub)), admin, admin, ""
        );

        PlamenHookStub hook = new PlamenHookStub();

        vm.recordLogs();
        ms.addHook(IMerkleSnapshotHook(address(hook)));
        Vm.Log[] memory addLogs = vm.getRecordedLogs();
        assertEq(addLogs.length, 0, "addHook emitted no event");

        vm.recordLogs();
        ms.removeHook(IMerkleSnapshotHook(address(hook)));
        Vm.Log[] memory rmLogs = vm.getRecordedLogs();
        assertEq(rmLogs.length, 0, "removeHook emitted no event");
    }

    /*//////////////////////////////////////////////////////////////
      P-4  EASIndexerResolver.bindSchema is permissionless, one-shot,
           and performs NO validation that the UID exists in EAS or
           names this resolver. Binding a junk UID permanently bricks
           the resolver: the real schema can never bind and every
           attestation reverts. Contradicts the function's own NatSpec.
    //////////////////////////////////////////////////////////////*/
    function test_P4_BindSchemaAcceptsAnyUidAndPermanentlyBricksTheResolver() public {
        SchemaRegistry registry = new SchemaRegistry();
        EAS eas = new EAS(ISchemaRegistry(address(registry)));

        // Operator deploys the resolver (tx 1 of the DeployEasResolver sequence).
        EASIndexerResolver resolver = new EASIndexerResolver(IEAS(address(eas)));

        // Operator registers the real schema (tx 2).
        bytes32 realUid =
            registry.register("string comment,uint256 confidence", ISchemaResolver(address(resolver)), true);

        // Griefer front-runs tx 3 with a UID that has nothing to do with this resolver.
        bytes32 junk = keccak256("not-a-schema-of-this-resolver");
        vm.prank(address(0xBAD));
        resolver.bindSchema(junk);
        assertEq(resolver.boundSchema(), junk, "any bytes32 is accepted, unvalidated");

        // The operator can never bind the real UID: one-shot.
        vm.expectRevert(EASIndexerResolver.SchemaAlreadyBound.selector);
        resolver.bindSchema(realUid);

        // And the instance is dead: every attestation on the real schema now reverts.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(EASIndexerResolver.ForeignSchema.selector, realUid, junk));
        eas.attest(
            AttestationRequest({
                schema: realUid,
                data: AttestationRequestData({
                    recipient: bob,
                    expirationTime: 0,
                    revocable: true,
                    refUID: bytes32(0),
                    data: abi.encode("c", uint256(95)),
                    value: 0
                })
            })
        );
    }

    /*//////////////////////////////////////////////////////////////
      P-5  REFUTATION (negative result, kept deliberately): the
           quorum-floors-to-zero arithmetic is NOT exploitable at the
           default 15% quorum. mulDiv(total, 15e16, 1e18) only floors to
           zero when total <= 6, and with integer scores the smallest
           possible voter then already holds >= 1/6 = 16.67% > 15%.
           It DOES become vacuous once an owner sets a very small
           quorum fraction, which is an explicit choice.
    //////////////////////////////////////////////////////////////*/
    function test_P5_QuorumFloorIsNotExploitableAtDefaultFraction() public pure {
        uint256 QUORUM_RANGE = 1e18;
        uint256 q = 15e16;
        // Largest total for which the threshold floors to zero.
        uint256 total = 6;
        assertEq((total * q) / QUORUM_RANGE, 0, "threshold floors to zero");
        // But the smallest nonzero voter is already above the 15% the quorum asked for.
        assertGt((uint256(1) * QUORUM_RANGE) / total, q, "1/6 > 15%");
    }
}

contract PlamenHookStub is IMerkleSnapshotHook {
    function onMerkleUpdate(IMerkleSnapshot.MerkleState memory) external {}
}

contract PlamenAccumulatorStub is IAttestationAccumulator {
    Checkpoint[] internal _cps;

    function acc() external pure returns (bytes32) {
        return bytes32(0);
    }

    function leafCount() external pure returns (uint64) {
        return 0;
    }

    function checkpoint() external returns (uint256 id) {
        id = _cps.length;
        _cps.push(Checkpoint({acc: bytes32(0), leafCount: 0, blockNumber: uint64(block.number)}));
    }

    function getCheckpoint(uint256 id) external view returns (Checkpoint memory) {
        return _cps[id];
    }

    function checkpointCount() external view returns (uint256) {
        return _cps.length;
    }
}
