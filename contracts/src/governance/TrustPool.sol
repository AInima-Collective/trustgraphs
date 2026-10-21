// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";

/// @title TrustPool
/// @notice A delegatee that votes as a trust graph. Token holders delegate to this address
///         (a plain `delegate(pool)`, or a Franchiser position naming it); scored accounts then
///         cast the pool's weight on a `GovernorCountingFractional` governor, each wielding
///         `poolVotes * score / totalScore`, all read at the proposal's snapshot block.
/// @dev Nothing is held: the pool's weight is whatever the governor counts for it at the
///      snapshot, and each voter's share is derived at vote time from a proof against the root
///      that governed that same block. A dropped score cannot be spent, because the root it lived
///      in no longer governs. The governor caps total casts at the pool's snapshot weight, and
///      Σ floor(share) never exceeds it anyway.
///      MerkleSnapshot files a root at its checkpoint's input-freeze block, so a checkpoint frozen
///      before a proposal's snapshot but proven after it changes what `getStateAtBlock` answers
///      for that snapshot mid-vote. The first vote therefore fixes the proposal's basis (root and
///      total) and every later vote is measured against it; both candidate roots describe the
///      graph as of the snapshot, so whichever the first voter meets is a valid one.
///      ponytail: weight left unvoted is never cast, so low turnout means a quieter pool. A
///      remainder sweep (pro-rata to the pool's own tally near the deadline) can be added later.
contract TrustPool {
    /// @notice OZ `GovernorCountingFractional.VOTE_TYPE_FRACTIONAL`.
    uint8 internal constant VOTE_TYPE_FRACTIONAL = 255;

    IGovernor public immutable governor;
    MerkleSnapshot public immutable snapshot;

    /// @notice The root and total score a proposal's shares are measured against.
    struct Basis {
        bytes32 root;
        uint256 totalValue;
    }

    mapping(uint256 proposalId => mapping(address account => bool)) public hasVoted;

    /// @notice Each proposal's basis, fixed by its first vote. Zero until then.
    mapping(uint256 proposalId => Basis) public proposalBasis;

    event Voted(
        uint256 indexed proposalId, address indexed voter, uint8 support, uint256 score, uint256 weight, string reason
    );

    error AlreadyVoted();
    error InvalidProof();
    error InvalidSupport();
    error ZeroWeight();

    constructor(IGovernor governor_, MerkleSnapshot snapshot_) {
        governor = governor_;
        snapshot = snapshot_;
    }

    /// @notice Cast the caller's share of the pool on `proposalId`.
    /// @param support 0 = Against, 1 = For, 2 = Abstain (Bravo order).
    /// @param score The caller's leaf value in the proposal's basis root: `proposalBasis` once
    ///        anyone has voted, otherwise the root `getStateAtBlock(proposalSnapshot)` returns.
    /// @param proof The merkle proof of `(msg.sender, score)` against that root.
    function vote(uint256 proposalId, uint8 support, uint256 score, bytes32[] calldata proof, string calldata reason)
        external
        returns (uint256 weight)
    {
        if (support > 2) revert InvalidSupport();
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted();
        hasVoted[proposalId][msg.sender] = true;

        uint256 snapshotBlock = governor.proposalSnapshot(proposalId);
        Basis memory basis = proposalBasis[proposalId];
        if (basis.root == bytes32(0)) {
            IMerkleSnapshot.MerkleState memory state = snapshot.getStateAtBlock(snapshotBlock);
            basis = Basis({root: state.root, totalValue: state.totalValue});
            proposalBasis[proposalId] = basis;
        }
        // Same double-hashed leaf as MerkleSnapshot._verifyProof.
        // forge-lint: disable-next-line(asm-keccak256)
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, score))));
        if (!MerkleProof.verifyCalldata(proof, basis.root, leaf)) revert InvalidProof();

        weight = governor.getVotes(address(this), snapshotBlock) * score / basis.totalValue;
        if (weight == 0) revert ZeroWeight();

        uint128 w = SafeCast.toUint128(weight);
        bytes memory params = support == 0
            ? abi.encodePacked(w, uint128(0), uint128(0))
            : support == 1 ? abi.encodePacked(uint128(0), w, uint128(0)) : abi.encodePacked(uint128(0), uint128(0), w);
        governor.castVoteWithReasonAndParams(proposalId, VOTE_TYPE_FRACTIONAL, reason, params);

        emit Voted(proposalId, msg.sender, support, score, weight, reason);
    }
}
