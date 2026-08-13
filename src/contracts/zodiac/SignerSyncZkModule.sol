// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Module} from "@gnosis-guild/zodiac-core/core/Module.sol";
import {Operation} from "@gnosis-guild/zodiac-core/core/Operation.sol";

import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";

/// @title SignerSyncZkModule
/// @notice Zodiac module that rotates a Safe's owner set to the top-scored trustgraph accounts,
///         gated by a permissionless zero-knowledge proof (the signer-sync analogue of
///         `MerkleSnapshot.submitProof`). A proof binds:
///           (a) the chain-pinned input commitment `(acc, leafCount)` of a checkpoint,
///           (b) the governance-pinned PageRank `paramsHash`,
///           (c) the governance-pinned `selectionParamsHash` (topN / minThreshold / targetBps),
///         and commits the resulting `signerSetRoot` + `targetThreshold`. The guest proves the
///         selection is the correct deterministic function of those inputs; this contract does the
///         owner-set *diff* on-chain against the Safe's real linked list (so `prevOwner` pointers
///         and the `1 <= threshold <= ownerCount` invariant are always correct — the two things the
///         old off-chain WAVS component got wrong). See SIGNER_SYNC_ZK_PLAN.md.
/// @dev The signer journal (frozen, reproduced by `pagerank-core::encode::signer_journal_encoded`):
///      `abi.encode(bytes32 acc, uint64 leafCount, bytes32 paramsHash, bytes32 selectionParamsHash,
///                  bytes32 signerSetRoot, uint256 targetThreshold, bytes32 instanceDomain)`.
///      `instanceDomain = keccak256(abi.encode(address(this), block.chainid))` is REBUILT here
///      rather than accepted as an argument (audit M-3), so an owner-rotation proof made for one
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

    /// @notice keccak256 of the canonical PageRank parameters the guest must use (same value as
    ///         `MerkleSnapshot.paramsHash` for a consistent score/signer view).
    bytes32 public paramsHash;

    /// @notice Narrow authority over only the shared PageRank commitment.
    /// @dev Begins as the module owner for backwards-compatible deployments, but can be handed to
    ///      the same operational Safe/timelock that owns a trust-graph params controller without
    ///      transferring the module's verifier, accumulator, or selection-policy authority.
    address public paramsAuthority;
    address public pendingParamsAuthority;

    /// @notice keccak256 of the selection parameters: `abi.encode(uint32 topN, uint32 minThreshold,
    ///         uint32 targetThresholdBps)`.
    bytes32 public selectionParamsHash;

    /// @notice The last checkpoint id whose proof was applied (monotonic).
    uint256 public lastAppliedCheckpoint;

    /// @notice Whether any checkpoint has been applied (distinguishes "none" from "checkpoint 0").
    bool public hasAppliedCheckpoint;

    bool private _initialized;

    /*///////////////////////////////////////////////////////////////
                            ERRORS / EVENTS
    //////////////////////////////////////////////////////////////*/

    error AlreadyInitialized();
    error ZeroAddress();
    error StaleCheckpoint(uint256 submitted, uint256 lastApplied);
    error EmptySignerSet();
    error InvalidSigner(address signer);
    error SignersNotStrictlyAscending();
    error InvalidThreshold(uint256 threshold, uint256 ownerCount);
    error SafeCallFailed(bytes data);
    error OwnerNotFound(address owner);
    error NotParamsAuthority(address caller);
    error InvalidParamsAuthority(address authority);

    event ZkVerifierUpdated(address indexed zkVerifier);
    event AccumulatorUpdated(address indexed accumulator);
    event ParamsHashUpdated(bytes32 paramsHash);
    event ParamsAuthorityTransferStarted(address indexed currentAuthority, address indexed pendingAuthority);
    event ParamsAuthorityTransferred(address indexed previousAuthority, address indexed newAuthority);
    event SelectionParamsHashUpdated(bytes32 selectionParamsHash);
    event SignersSynced(
        uint256 indexed checkpointId, bytes32 signerSetRoot, uint256 threshold, address indexed submitter
    );

    /*///////////////////////////////////////////////////////////////
                                SETUP
    //////////////////////////////////////////////////////////////*/

    /// @param _owner Governance authority (e.g. a TimelockController) over the module's knobs.
    /// @param _avatar The Safe the module manages (executes as).
    /// @param _target The contract the module calls (the Safe).
    /// @param _zkVerifier The proof verifier.
    /// @param _accumulator The attestation accumulator producing checkpoints.
    /// @param _paramsHash The canonical PageRank params hash.
    /// @param _selectionParamsHash The canonical selection params hash.
    constructor(
        address _owner,
        address _avatar,
        address _target,
        IZkVerifier _zkVerifier,
        IAttestationAccumulator _accumulator,
        bytes32 _paramsHash,
        bytes32 _selectionParamsHash
    ) {
        _init(_owner, _avatar, _target, _zkVerifier, _accumulator, _paramsHash, _selectionParamsHash);
    }

    /// @notice Factory (proxy) setup.
    function setUp(bytes memory initializeParams) public override {
        (
            address _owner,
            address _avatar,
            address _target,
            IZkVerifier _zkVerifier,
            IAttestationAccumulator _accumulator,
            bytes32 _paramsHash,
            bytes32 _selectionParamsHash
        ) = abi.decode(
            initializeParams, (address, address, address, IZkVerifier, IAttestationAccumulator, bytes32, bytes32)
        );
        _init(_owner, _avatar, _target, _zkVerifier, _accumulator, _paramsHash, _selectionParamsHash);
    }

    function _init(
        address _owner,
        address _avatar,
        address _target,
        IZkVerifier _zkVerifier,
        IAttestationAccumulator _accumulator,
        bytes32 _paramsHash,
        bytes32 _selectionParamsHash
    ) internal {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        if (
            _avatar == address(0) || _target == address(0) || address(_zkVerifier) == address(0)
                || address(_accumulator) == address(0)
        ) {
            revert ZeroAddress();
        }

        _transferOwnership(_owner);
        avatar = _avatar;
        target = _target;
        zkVerifier = _zkVerifier;
        accumulator = _accumulator;
        paramsHash = _paramsHash;
        paramsAuthority = _owner;
        selectionParamsHash = _selectionParamsHash;
    }

    /*///////////////////////////////////////////////////////////////
                            GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    function setZkVerifier(IZkVerifier _zkVerifier) external onlyOwner {
        if (address(_zkVerifier) == address(0)) revert ZeroAddress();
        zkVerifier = _zkVerifier;
        emit ZkVerifierUpdated(address(_zkVerifier));
    }

    function setAccumulator(IAttestationAccumulator _accumulator) external onlyOwner {
        if (address(_accumulator) == address(0)) revert ZeroAddress();
        accumulator = _accumulator;
        emit AccumulatorUpdated(address(_accumulator));
    }

    modifier onlyParamsAuthority() {
        if (msg.sender != paramsAuthority) revert NotParamsAuthority(msg.sender);
        _;
    }

    function transferParamsAuthority(address nextAuthority) external onlyOwner {
        if (nextAuthority == address(0)) revert InvalidParamsAuthority(nextAuthority);
        pendingParamsAuthority = nextAuthority;
        emit ParamsAuthorityTransferStarted(paramsAuthority, nextAuthority);
    }

    function acceptParamsAuthority() external {
        if (msg.sender != pendingParamsAuthority) revert NotParamsAuthority(msg.sender);
        address previous = paramsAuthority;
        paramsAuthority = msg.sender;
        pendingParamsAuthority = address(0);
        emit ParamsAuthorityTransferred(previous, msg.sender);
    }

    function setParamsHash(bytes32 _paramsHash) external onlyParamsAuthority {
        paramsHash = _paramsHash;
        emit ParamsHashUpdated(_paramsHash);
    }

    function setSelectionParamsHash(bytes32 _selectionParamsHash) external onlyOwner {
        selectionParamsHash = _selectionParamsHash;
        emit SelectionParamsHashUpdated(_selectionParamsHash);
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
        address[] calldata signers,
        uint256 targetThreshold,
        bytes calldata proof
    ) external {
        // Monotonic: an older (or equal) checkpoint cannot clobber a newer applied one.
        if (hasAppliedCheckpoint && checkpointId <= lastAppliedCheckpoint) {
            revert StaleCheckpoint(checkpointId, lastAppliedCheckpoint);
        }

        // Reverts if checkpointId is out of range.
        IAttestationAccumulator.Checkpoint memory c = accumulator.getCheckpoint(checkpointId);

        // Validate the canonical form and recompute the set commitment the guest proved.
        bytes32 signerSetRoot = _validateAndRoot(signers);
        if (targetThreshold < 1 || targetThreshold > signers.length) {
            revert InvalidThreshold(targetThreshold, signers.length);
        }

        // Rebuild the signer journal digest from stored (governance-pinned) + submitted (proven)
        // fields; a mismatch on ANY field fails verification. The final word binds the proof to
        // THIS module on THIS chain (audit M-3) — rebuilt, never submitted.
        bytes32 journalDigest = keccak256(
            abi.encode(
                c.acc,
                c.leafCount,
                paramsHash,
                selectionParamsHash,
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

        emit SignersSynced(checkpointId, signerSetRoot, targetThreshold, msg.sender);
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
        return _ozRoot(leaves);
    }

    /// @dev Minimal OpenZeppelin StandardMerkleTree root (sorted leaves, commutative parent hashing).
    ///      Byte-identical to `pagerank-core::merkle::seed_set_root` and `GoldenVectors._ozRoot`.
    function _ozRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 n = leaves.length;
        if (n == 0) return bytes32(0);
        // insertion sort (small n)
        for (uint256 i = 1; i < n; i++) {
            bytes32 key = leaves[i];
            uint256 j = i;
            while (j > 0 && leaves[j - 1] > key) {
                leaves[j] = leaves[j - 1];
                j--;
            }
            leaves[j] = key;
        }
        if (n == 1) return leaves[0];
        uint256 size = 2 * n - 1;
        bytes32[] memory tree = new bytes32[](size);
        for (uint256 i = 0; i < n; i++) {
            tree[size - 1 - i] = leaves[i];
        }
        for (uint256 i = n - 1; i > 0; i--) {
            uint256 idx = i - 1;
            bytes32 a = tree[2 * idx + 1];
            bytes32 b = tree[2 * idx + 2];
            tree[idx] = a <= b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
        }
        return tree[0];
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
