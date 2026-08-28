// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// Adjudication-tier VERIFICATION tests for clusters C7 / C9 / C10 / C20.
// Disposable.

import {Test, Vm} from "forge-std/Test.sol";

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";
import {Operation} from "@gnosis-guild/zodiac-core/core/Operation.sol";

import {MerkleGovModule} from "src/zodiac/MerkleGovModule.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IMerkleSnapshotHook} from "interfaces/merkle/IMerkleSnapshotHook.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {MockAccumulator} from "test/mocks/MockAccumulator.sol";
import {MockZkVerifier} from "test/mocks/MockZkVerifier.sol";

contract VerifySnapshotStub is IMerkleSnapshot {
    MerkleState private _s;
    bool private _has;

    function setLatestState(MerkleState memory s) external {
        _s = s;
        _has = true;
    }

    function getLatestState() external view returns (MerkleState memory) {
        if (!_has) revert IMerkleSnapshot.NoMerkleStates();
        return _s;
    }

    function pushUpdate(address hook) external {
        IMerkleSnapshotHook(hook).onMerkleUpdate(_s);
    }
}

/// A contract whose delegatecall body rewrites Safe storage slot 0 (the singleton slot is 0 in a
/// proxy; we use a harmless high slot instead so the test only proves *reachability*).
contract StorageWriter {
    function poke(uint256 slot, uint256 value) external {
        assembly {
            sstore(slot, value)
        }
    }
}

contract GovVerify is Test {
    GnosisSafe internal safeSingleton;
    GnosisSafeProxyFactory internal safeFactory;
    GnosisSafe internal safe;
    MerkleGovModule internal gov;
    VerifySnapshotStub internal snap;

    address internal creator = address(0xC0FFEE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    bytes32 internal leafAlice;
    bytes32 internal leafBob;
    bytes32 internal root;
    uint256 internal constant TOTAL = 300e18;

    // The exact shape every guest emits: cid_v1_raw() == "b" + base32(36 bytes) == 59 chars.
    string internal constant HONEST_CID = "bafkreiadmftlffbtqxvwtvctlfhcotxvzk3aq2wzxsrbmmb43e3tqzqx7q";

    function _leaf(address a, uint256 v) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a, v))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function _proofFor(address who) internal view returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = who == alice ? leafBob : leafAlice;
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
            payable(address(safeFactory.createProxyWithNonce(address(safeSingleton), setupData, uint256(7))))
        );

        leafAlice = _leaf(alice, 100e18);
        leafBob = _leaf(bob, 200e18);
        root = _pair(leafAlice, leafBob);

        snap = new VerifySnapshotStub();
        snap.setLatestState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: root,
                ipfsHash: bytes32(uint256(1)),
                ipfsHashCid: HONEST_CID,
                totalValue: TOTAL
            })
        );

        // PRODUCTION wiring: GovernedTrustgraphsFactory.sol:245
        //   GOV_MODULE_DEPLOYER.deploy(safeAddress, safeAddress, safeAddress, snapshot)
        gov = new MerkleGovModule(address(safe), address(safe), address(safe), address(snap));
        vm.prank(address(safe));
        safe.enableModule(address(gov));
        vm.deal(address(safe), 100 ether);
    }

    function _proposeOne(address target_, bytes memory data, Operation op) internal returns (uint256 id) {
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory datas = new bytes[](1);
        Operation[] memory ops = new Operation[](1);
        string[] memory descs = new string[](1);
        targets[0] = target_;
        datas[0] = data;
        ops[0] = op;
        descs[0] = "";
        vm.prank(bob);
        id = gov.propose("t", "d", targets, values, datas, ops, descs, 200e18, _proofFor(bob));
    }

    function _passAndExecute(uint256 id) internal {
        vm.roll(block.number + gov.votingDelay() + 1);
        vm.prank(bob);
        gov.castVote(id, MerkleGovModule.VoteType.Yes, 200e18, _proofFor(bob));
        (MerkleGovModule.Proposal memory p,,) = gov.getProposal(id);
        vm.roll(p.endBlock + gov.executionDelay() + 1);
        gov.execute(id);
    }

    /*//////////////////////////////////////////////////////////////
                                  C7
    //////////////////////////////////////////////////////////////*/

    /// V1: in PRODUCTION wiring the gov module's own owner is the Safe, so a single passed
    /// proposal flips the M-4 delegatecall allowlist. The allowlist is therefore a policy knob
    /// governance sets for itself, NOT a boundary on what governance may do.
    function test_V1_GovernanceCanAllowlistItsOwnDelegatecallTarget() public {
        StorageWriter w = new StorageWriter();
        assertEq(gov.owner(), address(safe), "production wiring: module owner == the Safe");
        assertFalse(gov.delegateCallAllowlist(address(w)), "not allowlisted at the start");

        uint256 id = _proposeOne(
            address(gov), abi.encodeCall(MerkleGovModule.setDelegateCallTarget, (address(w), true)), Operation.Call
        );
        _passAndExecute(id);

        assertTrue(gov.delegateCallAllowlist(address(w)), "one passed proposal opened the delegatecall allowlist");

        // ...and the second proposal now delegatecalls arbitrary code in the Safe's storage.
        uint256 id2 = _proposeOne(
            address(w), abi.encodeCall(StorageWriter.poke, (uint256(0x1234), 0xdead)), Operation.DelegateCall
        );
        _passAndExecute(id2);
        assertEq(uint256(vm.load(address(safe), bytes32(uint256(0x1234)))), 0xdead, "delegatecall ran in Safe storage");
    }

    /// V2: the PoC's "baseline" (delegatecall to the Safe is denied) is VACUOUS — even with the
    /// Safe explicitly allowlisted, a delegatecall to the Safe cannot reach `enableModule`,
    /// because delegatecall preserves msg.sender (the module) and Safe's `authorized` modifier
    /// requires msg.sender == address(this).
    function test_V2_DelegatecallToSafeCannotReachEnableModuleEvenWhenAllowlisted() public {
        address victimModule = address(uint160(0xBAD0));

        uint256 id = _proposeOne(
            address(gov), abi.encodeCall(MerkleGovModule.setDelegateCallTarget, (address(safe), true)), Operation.Call
        );
        _passAndExecute(id);
        assertTrue(gov.delegateCallAllowlist(address(safe)), "safe allowlisted for delegatecall");

        uint256 id2 = _proposeOne(
            address(safe), abi.encodeWithSignature("enableModule(address)", victimModule), Operation.DelegateCall
        );
        vm.roll(block.number + gov.votingDelay() + 1);
        vm.prank(bob);
        gov.castVote(id2, MerkleGovModule.VoteType.Yes, 200e18, _proofFor(bob));
        (MerkleGovModule.Proposal memory p,,) = gov.getProposal(id2);
        vm.roll(p.endBlock + gov.executionDelay() + 1);

        // The Safe's own `authorized` check rejects it; exec() returns false; M-8 makes it revert.
        vm.expectRevert(abi.encodeWithSelector(MerkleGovModule.ActionFailed.selector, uint256(0)));
        gov.execute(id2);
        assertFalse(safe.isModuleEnabled(victimModule), "delegatecall route never reached enableModule");
    }

    /*//////////////////////////////////////////////////////////////
                                  C9
    //////////////////////////////////////////////////////////////*/

    /// V3: the honest, guest-derived CID is 59 bytes and its hook write costs a small fraction of
    /// the 500k stipend. The starvation PoC needs a ~2000-byte CID.
    function test_V3_HonestCidLengthAndHookGasHeadroom() public {
        assertEq(bytes(HONEST_CID).length, 59, "cid_v1_raw() is always 59 chars: 'b' + base32(36 bytes)");

        IMerkleSnapshot.MerkleState memory s = IMerkleSnapshot.MerkleState({
            blockNumber: block.number,
            timestamp: block.timestamp,
            root: bytes32(uint256(0xabc)),
            ipfsHash: bytes32(uint256(9)),
            ipfsHashCid: HONEST_CID,
            totalValue: 1234e18
        });

        uint256 before = gasleft();
        vm.prank(address(snap));
        gov.onMerkleUpdate(s);
        uint256 used = before - gasleft();
        emit log_named_uint("onMerkleUpdate gas with a 59-byte CID", used);
        assertLt(used, 200_000, "honest CID leaves large headroom under HOOK_GAS_STIPEND = 500_000");
        assertEq(gov.currentMerkleRoot(), bytes32(uint256(0xabc)), "hook applied");
    }

    /// V4: a real verifier pins keccak256(ipfsHashCid) inside the journal digest, so the long-CID
    /// substitution the C9 PoC performs cannot produce an accepted proof.
    function test_V4_LongCidCannotBeSubstitutedUnderARealJournalBinding() public {
        MockAccumulator acc = new MockAccumulator();
        MockZkVerifier verifier = new MockZkVerifier();
        MerkleSnapshot ms = new MerkleSnapshot(
            verifier, keccak256("params"), IAttestationAccumulator(address(acc)), address(this), address(this), ""
        );
        MerkleGovModule module = new MerkleGovModule(address(this), address(this), address(this), address(ms));
        ms.addHook(IMerkleSnapshotHook(address(module)));

        acc.setState(keccak256("inputs"), 3);
        uint256 id = ms.trigger();
        IAttestationAccumulator.Checkpoint memory c = acc.getCheckpoint(id);

        bytes32 outputRoot = bytes32(uint256(0xfeed));
        bytes32 ipfsHash = keccak256("blob");
        uint256 totalValue = 1000e18;

        // The digest the GUEST committed: it hashed the 59-byte CID it derived from the blob.
        bytes32 honestDigest = keccak256(
            abi.encode(
                c.acc,
                c.leafCount,
                bytes32(0),
                uint64(0),
                keccak256("params"),
                outputRoot,
                ipfsHash,
                keccak256(bytes(HONEST_CID)),
                totalValue,
                bytes32(0),
                address(0xFEE),
                ms.instanceDomain()
            )
        );
        verifier.setExpectedDigest(honestDigest);

        // Substituting a 2000-byte CID (the C9 attack) changes keccak256(ipfsHashCid) and the
        // proof no longer verifies.
        bytes memory long_ = new bytes(2000);
        for (uint256 i = 0; i < 2000; i++) {
            long_[i] = bytes1(uint8(97 + (i % 26)));
        }
        vm.expectRevert(bytes("MockZkVerifier: digest mismatch"));
        ms.submitProof(id, outputRoot, ipfsHash, string(long_), totalValue, bytes32(0), address(0xFEE), hex"");

        // The honest CID is accepted and the governance hook lands.
        ms.submitProof(id, outputRoot, ipfsHash, HONEST_CID, totalValue, bytes32(0), address(0xFEE), hex"");
        assertEq(module.currentMerkleRoot(), outputRoot, "gov hook received the root under the honest CID");
        assertEq(module.totalVotingPower(), totalValue, "and the voting power");
    }

    /*//////////////////////////////////////////////////////////////
                                  C20
    //////////////////////////////////////////////////////////////*/

    /// V5: a passed proposal has a snapshotted upper execution bound, so C7's ordinary
    /// Call-to-Safe power cannot remain armed indefinitely after its mandate goes stale.
    function test_V5_SleeperProposalExpiresBeforeItCanTakeTheSafeYearsLater() public {
        address sleeperModule = address(uint160(0xBAD1));
        uint256 id =
            _proposeOne(address(safe), abi.encodeWithSignature("enableModule(address)", sleeperModule), Operation.Call);

        vm.roll(block.number + gov.votingDelay() + 1);
        vm.prank(bob);
        gov.castVote(id, MerkleGovModule.VoteType.Yes, 200e18, _proofFor(bob));
        (MerkleGovModule.Proposal memory p,,) = gov.getProposal(id);
        vm.roll(p.endBlock + 1);
        assertEq(uint256(gov.state(id)), uint256(MerkleGovModule.ProposalState.Passed), "passed");

        // Membership fully turns over.
        snap.setLatestState(
            IMerkleSnapshot.MerkleState({
                blockNumber: block.number,
                timestamp: block.timestamp,
                root: _leaf(address(0xDEAD), 1e18),
                ipfsHash: bytes32(uint256(2)),
                ipfsHashCid: HONEST_CID,
                totalValue: 1e18
            })
        );
        snap.pushUpdate(address(gov));

        // ~2 years of blocks later it is expired and cannot execute.
        vm.roll(block.number + 5_000_000);
        assertEq(uint256(gov.state(id)), uint256(MerkleGovModule.ProposalState.Expired), "proposal did not expire");
        vm.expectRevert(MerkleGovModule.ProposalNotPassed.selector);
        gov.execute(id);
        assertFalse(safe.isModuleEnabled(sleeperModule), "expired sleeper proposal seized the Safe");
    }

    /// V5b: the only brake is `cancel()`, and in production wiring only the Safe can pull it, so
    /// killing a sleeper needs ANOTHER passed proposal (or the 14-day recovery route).
    function test_V5b_CancelIsGatedOnTheSafeItself() public {
        uint256 id = _proposeOne(
            address(safe), abi.encodeWithSignature("enableModule(address)", address(uint160(0xBAD2))), Operation.Call
        );
        assertEq(gov.owner(), address(safe));
        vm.prank(alice);
        vm.expectRevert(MerkleGovModule.NotAuthorized.selector);
        gov.cancel(id);
        vm.prank(creator); // the 1-of-1 Safe *owner* cannot cancel either
        vm.expectRevert(MerkleGovModule.NotAuthorized.selector);
        gov.cancel(id);
    }

    /*//////////////////////////////////////////////////////////////
                                  C10
    //////////////////////////////////////////////////////////////*/

    /// V6: with a self-consistent root (leaf sum == totalValue, which every guest enforces) the
    /// tally can never exceed the snapshotted total, and quorum does not floor to zero.
    function test_V6_HonestRootKeepsTallyWithinTotalVotingPower() public {
        uint256 id = _proposeOne(address(0x1), "", Operation.Call);
        vm.roll(block.number + gov.votingDelay() + 1);
        vm.prank(alice);
        gov.castVote(id, MerkleGovModule.VoteType.Yes, 100e18, _proofFor(alice));
        vm.prank(bob);
        gov.castVote(id, MerkleGovModule.VoteType.No, 200e18, _proofFor(bob));
        (MerkleGovModule.Proposal memory p,,) = gov.getProposal(id);
        assertEq(p.yesVotes + p.noVotes + p.abstainVotes, p.totalVotingPower, "tally == leaf sum == totalValue");
        assertGt(p.totalVotingPower * gov.quorum() / 1e18, 0, "quorum threshold does not floor to zero");
    }
}
