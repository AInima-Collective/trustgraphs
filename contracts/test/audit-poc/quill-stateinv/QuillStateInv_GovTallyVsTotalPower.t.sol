// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {MerkleGovModule} from "src/zodiac/MerkleGovModule.sol";
import {Operation} from "@gnosis-guild/zodiac-core/core/Operation.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";

contract QuillGovSnapshotStub is IMerkleSnapshot {
    MerkleState internal _state;

    function set(bytes32 root, uint256 totalValue) external {
        _state = MerkleState({
            blockNumber: block.number,
            timestamp: block.timestamp,
            root: root,
            ipfsHash: keccak256("blob"),
            ipfsHashCid: "bafyquill",
            totalValue: totalValue
        });
    }

    function push(MerkleGovModule module) external {
        module.onMerkleUpdate(_state);
    }

    function getLatestState() external view returns (MerkleState memory) {
        if (_state.root == bytes32(0)) revert NoMerkleStates();
        return _state;
    }
}

/// @notice state-invariant-detection PoC for `MerkleGovModule`.
///
/// Invariant under test (Type 1, aggregation):
///   yesVotes + noVotes + abstainVotes <= totalVotingPower  (per proposal)
///
/// The module never enforces it. It snapshots `totalVotingPower` from the proven root's
/// `totalValue` and derives the quorum threshold as `mulDiv(totalVotingPower, quorumFraction,
/// 1e18)`, but each vote adds a leaf value that is only checked against `merkleRoot`. The two
/// numbers come from the same journal, so the module inherits - without any defence in depth -
/// the guest's promise that the leaves sum to `totalValue`.
///
/// `onMerkleUpdate`'s own comment claims the `totalValue == 0` case is safe because "`propose`
/// refuses (currentMerkleRoot == 0)". That is a different condition: `propose` refuses on a ZERO
/// ROOT, not on zero total value. A nonzero root with `totalValue == 0` is accepted, its quorum
/// threshold is exactly zero, and a single voter carries the proposal to `Passed`.
contract QuillStateInv_GovTallyVsTotalPower is Test {
    MerkleGovModule internal module;
    QuillGovSnapshotStub internal snap;

    address internal owner = address(0x0FEE);
    address internal avatar = address(0xA7A7);
    address internal voter = address(0x1234);

    function _leaf(address account, uint256 value) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, value))));
    }

    function setUp() public {
        snap = new QuillGovSnapshotStub();
        // A real proven root exists (single leaf: voter with 1_000 points) but the journal's
        // committed `totalValue` is zero.
        snap.set(_leaf(voter, 1_000), 0);
        module = new MerkleGovModule(owner, avatar, avatar, address(snap));
    }

    function test_TallyMayExceedSnapshottedTotalVotingPowerAndQuorumFloorsToZero() public {
        assertTrue(module.currentMerkleRoot() != bytes32(0), "root is set");
        assertEq(module.totalVotingPower(), 0, "total voting power is zero");

        address[] memory targets = new address[](0);
        uint256[] memory values = new uint256[](0);
        bytes[] memory calldatas = new bytes[](0);
        Operation[] memory ops = new Operation[](0);
        string[] memory descs = new string[](0);
        bytes32[] memory noProof = new bytes32[](0);

        // `propose` does NOT refuse: it only checks `currentMerkleRoot != 0`.
        vm.prank(voter);
        uint256 id = module.proposeWithVote(
            "quill", "desc", targets, values, calldatas, ops, descs, 1_000, noProof, MerkleGovModule.VoteType.Yes
        );

        (MerkleGovModule.Proposal memory p,,) = module.getProposal(id);
        assertEq(p.totalVotingPower, 0, "snapshotted total is zero");
        assertEq(p.yesVotes, 1_000, "one voter carries 1000 points");

        // BROKEN INVARIANT: the tally exceeds the snapshotted total voting power.
        assertGt(
            p.yesVotes + p.noVotes + p.abstainVotes,
            p.totalVotingPower,
            "tally must never exceed the snapshot it is measured against"
        );

        // ...and the quorum threshold is mulDiv(0, q, 1e18) == 0, so the proposal passes on one vote.
        vm.roll(block.number + p.endBlock + 1);
        assertEq(
            uint256(module.state(id)),
            uint256(MerkleGovModule.ProposalState.Passed),
            "single voter passed a proposal against a zero-power snapshot"
        );
    }
}
