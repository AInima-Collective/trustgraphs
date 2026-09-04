// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Module} from "@gnosis-guild/zodiac-core/core/Module.sol";
import {Operation} from "@gnosis-guild/zodiac-core/core/Operation.sol";

import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {OzMerkle} from "../merkle/OzMerkle.sol";

interface ISignerSyncCheckpointSource {
    function checkpointParamsHash(uint256 checkpointId) external view returns (bytes32);
}

interface ISignerActivitySource {
    struct ActivityCheckpoint {
        bytes32 acc;
        uint64 count;
        uint64 blockNumber;
    }

    function activityAccumulator() external view returns (bytes32);
    function activityCount() external view returns (uint64);
    function getActivityCheckpoint(uint256 checkpointId) external view returns (ActivityCheckpoint memory);
}

/// @title SignerSyncZkModule
/// @notice Zodiac module that rotates a Safe's owner set to the top-scored trustgraph accounts,
///         gated by a permissionless zero-knowledge proof (the signer-sync analogue of
///         `MerkleSnapshot.submitProof`). A proof binds:
///           (a) the chain-pinned input commitment `(acc, leafCount)` of a checkpoint,
///           (b) the score snapshot's checkpoint-pinned PageRank `paramsHash`,
///           (c) the governance-pinned selection and liveness policy,
///           (d) a complete direct-governance activity hash chain and the Safe's actual current
///               owner set,
///         and commits the resulting `signerSetRoot` + `targetThreshold`. The guest proves the
///         selection is the correct deterministic function of those inputs; this contract does the
///         owner-set *diff* on-chain against the Safe's real linked list (so `prevOwner` pointers
///         and the `1 <= threshold <= ownerCount` invariant are always correct). See
///         research/SIGNER_SYNC_ZK_PLAN.md.
/// @dev The signer journal (frozen, reproduced by `pagerank-core::encode::signer_journal_encoded`):
///      `abi.encode(bytes32 acc, uint64 leafCount, bytes32 paramsHash, bytes32 selectionParamsHash,
///                  bytes32 activityAcc, uint64 activityCount, uint64 activityBlock,
///                  bool wasInitialized, bytes32 currentSignerSetRoot, uint256 currentThreshold,
///                  bytes32 signerSetRoot, uint256 targetThreshold, bytes32 instanceDomain)`.
///      `instanceDomain = keccak256(abi.encode(address(this), block.chainid))` is REBUILT here
///      rather than accepted as an argument, so an owner-rotation proof made for one
///      module cannot be replayed against a same-params module sharing the accumulator, nor against
///      a mirrored deployment on another chain.
contract SignerSyncZkModule is Module {
    /// @notice Gnosis Safe OwnerManager linked-list sentinel.
    address internal constant SENTINEL = address(0x1);

    /*///////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice The proof verifier gating owner rotation (SP1 today; swappable behind IZkVerifier).
    IZkVerifier public zkVerifier;

    /// @notice The chained-hash accumulator over the attestation log (source of checkpoints).
    IAttestationAccumulator public accumulator;

    /// @notice The score snapshot that pins the PageRank params hash for each checkpoint.
    /// @dev Signer proofs consume the same frozen checkpoint as score proofs. Reading the pinned
    ///      hash here prevents a scoring rotation during proving from invalidating paid work.
    ISignerSyncCheckpointSource public scoreSnapshot;

    /// @notice The governed instance's authenticated direct-vote activity hash chain.
    ISignerActivitySource public activitySource;

    /// @notice keccak256 of the selection parameters: `abi.encode(uint32 topN, uint32 minThreshold,
    ///         uint32 targetThresholdBps)`.
    bytes32 public selectionParamsHash;
    uint64 public maxInactiveBlocks;

    /// @notice The last checkpoint id whose proof was applied (monotonic).
    uint256 public lastAppliedCheckpoint;

    /// @notice Whether any checkpoint has been applied (distinguishes "none" from "checkpoint 0").
    bool public hasAppliedCheckpoint;

    /// @notice A deliberate governance-controlled stop. Disabling the Safe module and pausing the
    ///         proof gate are separate, observable actions; either one stops owner rotation.
    bool public paused;

    /*///////////////////////////////////////////////////////////////
                            ERRORS / EVENTS
    //////////////////////////////////////////////////////////////*/

    error ProxyDeploymentUnsupported();
    error ZeroAddress();
    error StaleCheckpoint(uint256 submitted, uint256 lastApplied);
    error EmptySignerSet();
    error InvalidSigner(address signer);
    error SignersNotStrictlyAscending();
    error InvalidThreshold(uint256 threshold, uint256 ownerCount);
    error SafeCallFailed(bytes data);
    error OwnerNotFound(address owner);
    error UnpinnedCheckpoint(uint256 checkpointId);
    error SignerSyncPaused();
    error InvalidSelectionParams();
    error ActivityCheckpointSuperseded();
    error ActivityCheckpointStale(uint64 checkpointBlock, uint256 currentBlock);
    error AccumulatorRotationLocked(uint256 currentCheckpointCount, uint256 candidateCheckpointCount);

    event ZkVerifierUpdated(address indexed zkVerifier);
    event AccumulatorUpdated(address indexed accumulator);
    event SelectionParamsHashUpdated(bytes32 selectionParamsHash);
    event ActivitySourceUpdated(address indexed activitySource);
    event SignerSyncPausedUpdated(bool paused);
    event SignersSynced(
        uint256 indexed checkpointId,
        bytes32 signerSetRoot,
        uint256 threshold,
        address indexed submitter,
        address[] signers
    );

    /*///////////////////////////////////////////////////////////////
                                SETUP
    //////////////////////////////////////////////////////////////*/

    /// @param _owner Governance authority (e.g. a TimelockController) over the module's knobs.
    /// @param _avatar The Safe the module manages (executes as).
    /// @param _target The contract the module calls (the Safe).
    /// @param _zkVerifier The proof verifier.
    /// @param _accumulator The attestation accumulator producing checkpoints.
    /// @param _scoreSnapshot The score snapshot that pins params per checkpoint.
    /// @param _activitySource The governed instance's direct-vote activity source.
    constructor(
        address _owner,
        address _avatar,
        address _target,
        IZkVerifier _zkVerifier,
        IAttestationAccumulator _accumulator,
        ISignerSyncCheckpointSource _scoreSnapshot,
        ISignerActivitySource _activitySource,
        uint32 _topN,
        uint32 _minThreshold,
        uint32 _targetThresholdBps,
        uint64 _maxInactiveBlocks,
        uint32 _minActivityWitnesses
    ) {
        if (
            _avatar == address(0) || _target == address(0) || address(_zkVerifier) == address(0)
                || address(_accumulator) == address(0) || address(_scoreSnapshot) == address(0)
                || address(_activitySource) == address(0)
        ) {
            revert ZeroAddress();
        }

        _transferOwnership(_owner);
        avatar = _avatar;
        target = _target;
        zkVerifier = _zkVerifier;
        accumulator = _accumulator;
        scoreSnapshot = _scoreSnapshot;
        activitySource = _activitySource;
        _setSelectionParams(_topN, _minThreshold, _targetThresholdBps, _maxInactiveBlocks, _minActivityWitnesses);
    }

    /// @notice Zodiac proxy-factory deployment is unsupported: the module is always deployed via
    ///         `new` with its full configuration in the constructor.
    function setUp(bytes memory) public pure override {
        revert ProxyDeploymentUnsupported();
    }

    /*///////////////////////////////////////////////////////////////
                            GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    function setZkVerifier(IZkVerifier _zkVerifier) external onlyOwner {
        if (address(_zkVerifier) == address(0)) revert ZeroAddress();
        zkVerifier = _zkVerifier;
        emit ZkVerifierUpdated(address(_zkVerifier));
    }

    /// @notice Update the accumulator only before either accumulator has checkpoint history.
    /// @dev Mirrors MerkleSnapshot's fail-closed rotation protocol: checkpoint ids have meaning
    ///      only within one accumulator history, so a live or pre-used lane cannot be swapped in.
    ///      The high-water state is explicitly cleared on the sole safe (both-empty) rotation path.
    function setAccumulator(IAttestationAccumulator _accumulator) external onlyOwner {
        if (address(_accumulator) == address(0)) revert ZeroAddress();
        if (_accumulator == accumulator) {
            emit AccumulatorUpdated(address(_accumulator));
            return;
        }
        uint256 currentCheckpointCount = accumulator.checkpointCount();
        uint256 candidateCheckpointCount = _accumulator.checkpointCount();
        if (currentCheckpointCount != 0 || candidateCheckpointCount != 0) {
            revert AccumulatorRotationLocked(currentCheckpointCount, candidateCheckpointCount);
        }
        accumulator = _accumulator;
        lastAppliedCheckpoint = 0;
        hasAppliedCheckpoint = false;
        emit AccumulatorUpdated(address(_accumulator));
    }

    function setSelectionParams(
        uint32 topN,
        uint32 minThreshold,
        uint32 targetThresholdBps,
        uint64 maxInactiveBlocks_,
        uint32 minActivityWitnesses
    ) external onlyOwner {
        _setSelectionParams(topN, minThreshold, targetThresholdBps, maxInactiveBlocks_, minActivityWitnesses);
    }

    function setActivitySource(ISignerActivitySource activitySource_) external onlyOwner {
        if (address(activitySource_) == address(0)) revert ZeroAddress();
        activitySource = activitySource_;
        emit ActivitySourceUpdated(address(activitySource_));
    }

    /// @notice Stop or resume proof-authorized owner rotation through a delayed Safe action.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit SignerSyncPausedUpdated(paused_);
    }

    /*///////////////////////////////////////////////////////////////
                            PROOF SUBMISSION
    //////////////////////////////////////////////////////////////*/

    /// @notice Submit a proof that `signers` are the correct top-N selection for a checkpoint, and
    ///         rotate the Safe's owner set + threshold to match. Permissionless.
    /// @param checkpointId The checkpoint whose inputs the proof consumes.
    /// @param signers The proven owner set, strictly ascending by address (canonical, unique).
    /// @param targetThreshold The proven Safe threshold (1 <= targetThreshold <= signers.length).
    /// @param proof The verifier-specific proof blob.
    function submitSignerProof(
        uint256 checkpointId,
        uint256 activityCheckpointId,
        address[] calldata signers,
        uint256 targetThreshold,
        bytes calldata proof
    ) external {
        if (paused) revert SignerSyncPaused();
        // Monotonic: an older (or equal) checkpoint cannot clobber a newer applied one.
        if (hasAppliedCheckpoint && checkpointId <= lastAppliedCheckpoint) {
            revert StaleCheckpoint(checkpointId, lastAppliedCheckpoint);
        }

        // Reverts if checkpointId is out of range.
        IAttestationAccumulator.Checkpoint memory c = accumulator.getCheckpoint(checkpointId);
        bytes32 pinnedParamsHash = scoreSnapshot.checkpointParamsHash(checkpointId);
        if (pinnedParamsHash == bytes32(0)) revert UnpinnedCheckpoint(checkpointId);

        ISignerActivitySource.ActivityCheckpoint memory activity =
            activitySource.getActivityCheckpoint(activityCheckpointId);
        if (activity.acc != activitySource.activityAccumulator() || activity.count != activitySource.activityCount()) {
            revert ActivityCheckpointSuperseded();
        }
        if (block.number > uint256(activity.blockNumber) + maxInactiveBlocks) {
            revert ActivityCheckpointStale(activity.blockNumber, block.number);
        }

        address[] memory currentOwners = _currentOwners();
        uint256 currentThreshold = _currentThreshold();
        bytes32 currentSignerSetRoot = _ownerSetRoot(currentOwners);

        // Validate the canonical form and recompute the set commitment the guest proved.
        bytes32 signerSetRoot = _validateAndRoot(signers);
        if (targetThreshold < 1 || targetThreshold > signers.length) {
            revert InvalidThreshold(targetThreshold, signers.length);
        }

        // Rebuild the signer journal digest from stored (governance-pinned) + submitted (proven)
        // fields; a mismatch on ANY field fails verification. The final word binds the proof to
        // THIS module on THIS chain — rebuilt, never submitted.
        bytes32 journalDigest = keccak256(
            abi.encode(
                c.acc,
                c.leafCount,
                pinnedParamsHash,
                selectionParamsHash,
                activity.acc,
                activity.count,
                activity.blockNumber,
                hasAppliedCheckpoint,
                currentSignerSetRoot,
                currentThreshold,
                signerSetRoot,
                targetThreshold,
                keccak256(abi.encode(address(this), block.chainid))
            )
        );

        // Reverts on an invalid proof.
        zkVerifier.verify(proof, journalDigest);

        lastAppliedCheckpoint = checkpointId;
        hasAppliedCheckpoint = true;

        _syncOwners(signers, targetThreshold);

        emit SignersSynced(checkpointId, signerSetRoot, targetThreshold, msg.sender, signers);
    }

    /*///////////////////////////////////////////////////////////////
                        OWNER-SET DIFF (on-chain)
    //////////////////////////////////////////////////////////////*/

    /// @dev Rotate the Safe's owner set to `desired`, computing add/remove/swap ops (and their
    ///      `prevOwner` pointers) against the Safe's REAL current owner list, and preserving the
    ///      `1 <= threshold <= ownerCount` invariant at every intermediate step.
    function _syncOwners(address[] memory desired, uint256 targetThreshold) internal {
        address[] memory list = _currentOwners();
        uint256 curThreshold = _currentThreshold();

        // Partition: removals (in list, not desired) and additions (in desired, not list).
        uint256 rCount;
        uint256 aCount;
        for (uint256 i = 0; i < list.length; i++) {
            if (!_contains(desired, list[i])) rCount++;
        }
        for (uint256 i = 0; i < desired.length; i++) {
            if (!_contains(list, desired[i])) aCount++;
        }

        address[] memory toRemove = new address[](rCount);
        address[] memory toAdd = new address[](aCount);
        uint256 ri;
        uint256 ai;
        for (uint256 i = 0; i < list.length; i++) {
            if (!_contains(desired, list[i])) toRemove[ri++] = list[i];
        }
        for (uint256 i = 0; i < desired.length; i++) {
            if (!_contains(list, desired[i])) toAdd[ai++] = desired[i];
        }

        uint256 s = rCount < aCount ? rCount : aCount;

        // 1. Swaps: replace a removed owner with an added one in place. Count & threshold unchanged.
        for (uint256 k = 0; k < s; k++) {
            address prev = _prevOwner(list, toRemove[k]);
            _execSafe(abi.encodeWithSignature("swapOwner(address,address,address)", prev, toRemove[k], toAdd[k]));
            _replaceInPlace(list, toRemove[k], toAdd[k]);
        }

        // 2. Additions: Safe inserts each new owner right after SENTINEL (front of the list). Count
        //    grows, so keeping the current threshold is always valid.
        for (uint256 k = s; k < aCount; k++) {
            _execSafe(abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", toAdd[k], curThreshold));
            list = _prepend(list, toAdd[k]);
        }

        // 3. Removals: count shrinks; clamp the threshold to the new owner count (>= 1) as we go.
        for (uint256 k = s; k < rCount; k++) {
            address prev = _prevOwner(list, toRemove[k]);
            uint256 newCount = list.length - 1;
            uint256 th = curThreshold > newCount ? newCount : curThreshold;
            if (th < 1) th = 1;
            _execSafe(abi.encodeWithSignature("removeOwner(address,address,uint256)", prev, toRemove[k], th));
            list = _remove(list, toRemove[k]);
            curThreshold = th;
        }

        // 4. Final threshold to the proven target (1 <= target <= |desired|, checked by caller).
        if (_currentThreshold() != targetThreshold) {
            _execSafe(abi.encodeWithSignature("changeThreshold(uint256)", targetThreshold));
        }
    }

    /*///////////////////////////////////////////////////////////////
                            INTERNAL HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Validate the signer set is canonical (non-empty, no zero/sentinel, strictly ascending →
    ///      unique + sorted) and return its OZ StandardMerkleTree root.
    function _validateAndRoot(address[] calldata signers) internal pure returns (bytes32) {
        uint256 n = signers.length;
        if (n == 0) revert EmptySignerSet();
        bytes32[] memory leaves = new bytes32[](n);
        address prev = address(0);
        for (uint256 i = 0; i < n; i++) {
            address sgn = signers[i];
            if (sgn == address(0) || sgn == SENTINEL) revert InvalidSigner(sgn);
            if (i > 0 && sgn <= prev) revert SignersNotStrictlyAscending();
            prev = sgn;
            leaves[i] = keccak256(abi.encode(sgn));
        }
        return OzMerkle.root(leaves);
    }

    function _ownerSetRoot(address[] memory owners) internal pure returns (bytes32) {
        bytes32[] memory leaves = new bytes32[](owners.length);
        for (uint256 i = 0; i < owners.length; i++) {
            leaves[i] = keccak256(abi.encode(owners[i]));
        }
        return OzMerkle.root(leaves);
    }

    function _setSelectionParams(
        uint32 topN,
        uint32 minThreshold,
        uint32 targetThresholdBps,
        uint64 maxInactiveBlocks_,
        uint32 minActivityWitnesses
    ) internal {
        if (
            topN < 2 || minThreshold < 2 || minThreshold > topN || targetThresholdBps == 0
                || targetThresholdBps > 10_000 || maxInactiveBlocks_ == 0 || minActivityWitnesses < 2
                || minActivityWitnesses > topN
        ) revert InvalidSelectionParams();
        selectionParamsHash =
            keccak256(abi.encode(topN, minThreshold, targetThresholdBps, maxInactiveBlocks_, minActivityWitnesses));
        maxInactiveBlocks = maxInactiveBlocks_;
        emit SelectionParamsHashUpdated(selectionParamsHash);
    }

    /// @dev The Safe's current owners, in linked-list order.
    function _currentOwners() internal view returns (address[] memory) {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature("getOwners()"));
        if (!ok) revert SafeCallFailed(ret);
        return abi.decode(ret, (address[]));
    }

    /// @dev The Safe's current threshold.
    function _currentThreshold() internal view returns (uint256) {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSignature("getThreshold()"));
        if (!ok) revert SafeCallFailed(ret);
        return abi.decode(ret, (uint256));
    }

    /// @dev Execute a call on the Safe (as the avatar), reverting on failure.
    function _execSafe(bytes memory data) internal {
        bool ok = exec(target, 0, data, Operation.Call);
        if (!ok) revert SafeCallFailed(data);
    }

    /// @dev The linked-list predecessor of `owner` in `list` (SENTINEL if first). Reverts if absent.
    function _prevOwner(address[] memory list, address owner) internal pure returns (address) {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == owner) {
                return i == 0 ? SENTINEL : list[i - 1];
            }
        }
        revert OwnerNotFound(owner);
    }

    function _contains(address[] memory arr, address x) internal pure returns (bool) {
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] == x) return true;
        }
        return false;
    }

    function _replaceInPlace(address[] memory list, address oldA, address newA) internal pure {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == oldA) {
                list[i] = newA;
                return;
            }
        }
        revert OwnerNotFound(oldA);
    }

    /// @dev Return a new array with `owner` prepended (Safe inserts new owners after SENTINEL).
    function _prepend(address[] memory list, address owner) internal pure returns (address[] memory) {
        address[] memory out = new address[](list.length + 1);
        out[0] = owner;
        for (uint256 i = 0; i < list.length; i++) {
            out[i + 1] = list[i];
        }
        return out;
    }

    /// @dev Return a new array with `owner` removed (order preserved).
    function _remove(address[] memory list, address owner) internal pure returns (address[] memory) {
        address[] memory out = new address[](list.length - 1);
        uint256 j;
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == owner) continue;
            out[j++] = list[i];
        }
        return out;
    }
}
