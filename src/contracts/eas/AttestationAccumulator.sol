// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {ISnapshotAccumulatorView} from "interfaces/merkle/ISnapshotAccumulatorView.sol";

/// @title AttestationAccumulator
/// @notice Abstract mix-in that folds every edge passing through a resolver into a chained keccak
///         hash and lets anyone checkpoint the running state. Inherited by exactly ONE live feeder
///         (the single-schema EASIndexerResolver) so there is one ordered log = one `acc`
///         (see ZK_ARCHITECTURE.md §3.2, the one-accumulator-per-checkpoint invariant).
///
/// @dev The leaf and fold encodings are frozen and reproduced byte-for-byte by the zkVM guest
///      (`pagerank-core::encode`): the guest re-folds all leaves and asserts it reproduces `acc`,
///      which is how input completeness is proven.
abstract contract AttestationAccumulator is IAttestationAccumulator {
    /// @inheritdoc IAttestationAccumulator
    bytes32 public acc;

    /// @inheritdoc IAttestationAccumulator
    uint64 public leafCount;

    /// @notice All checkpoints, indexed by id.
    Checkpoint[] public checkpoints;

    /// @notice The only address allowed to mint checkpoints: the `MerkleSnapshot` whose
    ///         `trigger()` freezes this lane. Set once, via `bindSnapshot`.
    /// @dev Before this existed, `checkpoint()` was open to anyone (issue #10), which broke two
    ///      things the rest of the system asserts. First, `MerkleSnapshot`'s `epochLength` gate:
    ///      a prover wanting a boundary at block N called `checkpoint()` at block N and proved
    ///      against it, so "epoch boundaries are never prover-chosen"
    ///      (`MerkleSnapshot.sol:44-46`) was false. Second, and worse for a two-lane instance, a
    ///      directly-minted id was never seen by `trigger()`, so the snapshot's
    ///      `anchorCheckpoints[id]` sat at `(0, 0)` and a proof over an EMPTY lane 2 verified
    ///      against it — the AUDIT_M6.md M6-1 shape, which `TrustAccumulatorMirror` was already
    ///      hardened against but this mix-in was not.
    address public snapshot;

    /// @notice The deployer, and the only address that may perform the one-shot `bindSnapshot`.
    /// @dev Gated rather than permissionless (unlike `EASIndexerResolver.bindSchema`), because
    ///      nothing in a snapshot's address commits to this accumulator: a stranger who bound
    ///      first would wedge the real snapshot's `trigger()` forever.
    address public immutable binder;

    /// @notice Emitted once, when the accumulator is bound to the snapshot that owns its epochs.
    event SnapshotBound(address snapshot);

    /// @notice `checkpoint()` called by anything other than the bound snapshot (or before binding).
    error NotSnapshot();
    /// @notice `bindSnapshot` called twice.
    error AlreadyBound();
    /// @notice `bindSnapshot` called by anyone but the deployer.
    error NotBinder();
    /// @notice `bindSnapshot` given the zero address.
    error ZeroSnapshot();
    /// @notice `bindSnapshot` given a snapshot whose `accumulator()` is not this contract.
    error SnapshotReadsAnotherAccumulator(address reads);

    constructor() {
        binder = msg.sender;
    }

    /// @notice One-shot: bind the `MerkleSnapshot` whose `trigger()` may mint checkpoints here.
    /// @dev A post-deploy call rather than a constructor argument because of the deployment
    ///      cycle: the snapshot's constructor takes the accumulator, so the accumulator must
    ///      exist first. Same shape as the contributions `TrustAccumulatorMirror.bindSnapshot`.
    ///
    ///      The `accumulator()` read-back is defence in depth: it turns a mistyped binding — the
    ///      one irreversible mistake available here — into a revert. It also fixes the ordering
    ///      when an instance rotates its input lane: deploy the new accumulator, call the
    ///      snapshot's constitutional `setAccumulator`, THEN bind.
    function bindSnapshot(address _snapshot) external {
        if (msg.sender != binder) revert NotBinder();
        if (snapshot != address(0)) revert AlreadyBound();
        if (_snapshot == address(0)) revert ZeroSnapshot();

        address reads = ISnapshotAccumulatorView(_snapshot).accumulator();
        if (reads != address(this)) revert SnapshotReadsAnotherAccumulator(reads);

        snapshot = _snapshot;
        emit SnapshotBound(_snapshot);
    }

    /// @notice Fold one edge into the accumulator.
    /// @dev Called INLINE from the resolver's onAttest/onRevoke, so `block.timestamp` is exactly the
    ///      attestation's block time — the ordering key the guest reconciles on. Do not call `_fold`
    ///      from a deferred/batched context or the committed timestamp would drift from the edge.
    /// @param kind 0 = attest, 1 = revoke.
    /// @param attester The attester address.
    /// @param recipient The recipient address.
    /// @param uid The attestation uid.
    /// @param dataHash keccak256 of the raw attestation data.
    function _fold(uint8 kind, address attester, address recipient, bytes32 uid, bytes32 dataHash) internal {
        bytes32 leaf = keccak256(abi.encode(kind, attester, recipient, uid, block.timestamp, dataHash));
        acc = keccak256(abi.encode(acc, leaf));
        emit EdgeFolded(leafCount, leaf, acc);
        leafCount++;
    }

    /// @inheritdoc IAttestationAccumulator
    /// @dev Only the bound snapshot may mint, so every checkpoint id lands on the contract-fixed
    ///      epoch boundary with both lanes frozen and its `paramsHash` pinned.
    function checkpoint() external returns (uint256 id) {
        if (msg.sender != snapshot || snapshot == address(0)) revert NotSnapshot();

        uint256 len = checkpoints.length;
        // Anti-spam / correctness: a checkpoint must capture at least one new edge, except the very
        // first (which may legitimately freeze an empty input set).
        if (len != 0 && leafCount <= checkpoints[len - 1].leafCount) {
            revert NoNewInputs();
        }
        id = len;
        checkpoints.push(Checkpoint({acc: acc, leafCount: leafCount, blockNumber: uint64(block.number)}));
        emit InputsCheckpointed(id, acc, leafCount, uint64(block.number));
    }

    /// @inheritdoc IAttestationAccumulator
    function getCheckpoint(uint256 id) external view returns (Checkpoint memory) {
        return checkpoints[id];
    }

    /// @inheritdoc IAttestationAccumulator
    function checkpointCount() external view returns (uint256) {
        return checkpoints.length;
    }
}
