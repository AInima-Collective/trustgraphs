// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IMerkleSnapshotHook} from "interfaces/merkle/IMerkleSnapshotHook.sol";
import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IAnchorRegistry} from "interfaces/registry/IAnchorRegistry.sol";

/// @title MerkleSnapshot
/// @notice Merkle-root snapshotter for trustgraphs. The `{account => score}` root is produced by a
///         permissionless zero-knowledge proof of correct fixed-point Trust-Aware PageRank
///         (`submitProof`) instead of a WAVS operator quorum. A proof binds:
///           (a) the chain-pinned input commitment `(acc, leafCount)` of a checkpoint, and
///           (b) the governance-pinned `paramsHash`,
///         then writes through the same historical-state path every consumer already reads.
/// @dev Two-tier authority (AccessControl + timelocks): CONSTITUTIONAL_ROLE owns the truth-defining
///      knobs (`zkVerifier`, `accumulator`); OPERATIONAL_ROLE owns `paramsHash`. See ZK_ARCHITECTURE.md.
contract MerkleSnapshot is IMerkleSnapshot, AccessControl {
    /// @notice Owns `zkVerifier` and `accumulator` — changes what "correct PageRank" means.
    bytes32 public constant CONSTITUTIONAL_ROLE = keccak256("CONSTITUTIONAL_ROLE");
    /// @notice Owns `paramsHash` — governance-cadence parameter changes.
    bytes32 public constant OPERATIONAL_ROLE = keccak256("OPERATIONAL_ROLE");

    /// @notice Number of live constitutional authorities. Never allowed to reach zero.
    uint256 public constitutionalHolderCount;

    /// @notice Current two-step constitutional handoff, if any.
    address public pendingConstitutionalTransferor;
    address public pendingConstitutionalSuccessor;

    /// @notice The chained-hash accumulator over the attestation log (source of checkpoints).
    IAttestationAccumulator public accumulator;

    /// @notice Lane-2 anchor log (OFFCHAIN doc §4). Zero address = lane-1-only instance: trigger
    ///         checkpoints the empty lane as the zero accumulator and the guest asserts the empty
    ///         fold (empty-lane-as-zero — one journal shape for every instance).
    IAnchorRegistry public anchorRegistry;

    /// @notice A frozen lane-2 snapshot taken at the same trigger as the lane-1 checkpoint.
    struct AnchorCheckpoint {
        bytes32 anchorAcc;
        uint64 anchorCount;
    }

    /// @notice Lane-2 checkpoint per lane-1 checkpoint id (zeros when no registry is set).
    mapping(uint256 checkpointId => AnchorCheckpoint) public anchorCheckpoints;

    /// @notice Contract-fixed epoch schedule in blocks; 0 = unscheduled (lane-1-only default).
    ///         A nonzero schedule is anchored when configured; callers consume its boundaries but
    ///         cannot move the phase by triggering late (OFFCHAIN doc §4.1).
    uint64 public epochLength;

    /// @notice Origin of the current nonzero epoch schedule. Zero while unscheduled.
    uint64 public epochOriginBlock;

    /// @notice Last consumed scheduled boundary (or actual trigger block while unscheduled).
    /// @dev The checkpoint itself records the actual freeze block. Keeping the scheduled boundary
    ///      here makes `lastTriggerBlock + epochLength` the next immutable boundary even when a
    ///      permissionless caller triggers late.
    uint64 public lastTriggerBlock;

    /// @notice The proof verifier gating the write (SP1 today; swappable behind IZkVerifier).
    IZkVerifier public zkVerifier;

    /// @notice keccak256 of the canonical PageRank parameters the guest must use.
    bytes32 public paramsHash;

    /// @notice The `paramsHash` a checkpoint must be proven under, pinned by `trigger()` at the
    ///         moment the inputs froze. Zero = never pinned (see `UnpinnedCheckpoint`).
    /// @dev    Pinning is what lets a params rotation take effect at the next epoch boundary
    ///         instead of invalidating whatever proof is in flight — the hand-timed dance
    ///         `UPGRADE_GOVERNANCE.md` §5.6 asks operators to perform today. The VERIFIER is
    ///         deliberately NOT pinned: rotating it is the emergency response to an SP1 soundness
    ///         bug (§5.5), and pinning would let proofs under a known-broken verifier keep landing.
    mapping(uint256 checkpointId => bytes32 paramsHash) public checkpointParamsHash;

    /// @notice Next checkpoint id this snapshot requires its accumulator to return.
    /// @dev Prevents a malformed/re-pointed accumulator from reusing or skipping ids and thereby
    ///      overwriting checkpoint-bound parameter or anchor commitments.
    uint256 public nextCheckpointId;

    /// @notice The journal-committed payee of the proof that applied a checkpoint, recorded so a
    ///         bounty can be settled against the ROOT rather than against who submitted it.
    /// @dev Without this, `submitProof` being permissionless is a way to strip a prover's fee for
    ///      the price of one transaction: copy their pending claim out of the mempool, land the
    ///      identical proof directly here, and their vault call reverts `StaleCheckpoint` while
    ///      the checkpoint can never be applied again. The fee would be unpayable by anyone. Now
    ///      the recipient survives the submission, so `ProvingVault.claim` pays it afterwards and
    ///      the copier has bought nothing.
    mapping(uint256 checkpointId => address recipient) public checkpointRecipient;

    /// @notice The last checkpoint id whose proof was applied (monotonic).
    uint256 public lastAppliedCheckpoint;

    /// @notice Whether any checkpoint has been applied (distinguishes "none" from "checkpoint 0").
    bool public hasAppliedCheckpoint;

    /// @notice Historical merkle states, keyed by index
    mapping(uint256 stateIndex => MerkleState state) public states;

    /// @notice Array of block numbers where states were created (ascending)
    /// @dev Used for efficient binary search of historical states
    uint256[] public stateBlocks;

    /// @notice Mapping from block number to state index for efficient lookups
    /// @dev Only one state per block is allowed
    mapping(uint256 blockNumber => uint256 stateIndex) public blockToStateIndex;

    /// @notice Dense, one-indexed set of contracts to execute when the merkle state is updated.
    mapping(uint256 hookIndex => IMerkleSnapshotHook hook) public hooks;
    /// @notice Mapping from hook to hook index for efficient removal.
    mapping(IMerkleSnapshotHook hook => uint256 hookIndex) public hookIndex;
    /// @notice One past the last live hook. Starts at 1 since 0 is the membership sentinel.
    uint64 public nextHookIndex = 1;
    /// @notice The number of hooks.
    uint64 public hookCount;

    /// @notice Per-hook gas budget for `onMerkleUpdate`. Ample for a legitimate consumer's state
    ///         writes while bounding a griefing hook; a hook that exceeds it is skipped, not fatal.
    uint256 public constant HOOK_GAS_STIPEND = 500_000;

    /// @param _zkVerifier The initial proof verifier.
    /// @param _paramsHash The initial canonical params hash.
    /// @param _accumulator The attestation accumulator that produces checkpoints.
    /// @param constitutionalAdmin Authority (e.g. long-timelock) over the truth-defining knobs.
    /// @param operationalAdmin Authority (e.g. short-timelock) over `paramsHash`.
    constructor(
        IZkVerifier _zkVerifier,
        bytes32 _paramsHash,
        IAttestationAccumulator _accumulator,
        address constitutionalAdmin,
        address operationalAdmin
    ) {
        if (
            address(_zkVerifier) == address(0) || address(_accumulator) == address(0)
                || constitutionalAdmin == address(0) || operationalAdmin == address(0)
        ) {
            revert ZeroAddress();
        }
        if (_paramsHash == bytes32(0)) revert ZeroParamsHash();
        zkVerifier = _zkVerifier;
        paramsHash = _paramsHash;
        accumulator = _accumulator;

        // Constitutional role administers both roles (an operational compromise cannot escalate).
        _setRoleAdmin(CONSTITUTIONAL_ROLE, CONSTITUTIONAL_ROLE);
        _setRoleAdmin(OPERATIONAL_ROLE, CONSTITUTIONAL_ROLE);
        _grantRole(CONSTITUTIONAL_ROLE, constitutionalAdmin);
        _grantRole(OPERATIONAL_ROLE, operationalAdmin);
    }

    /*///////////////////////////////////////////////////////////////
                        GOVERNANCE (two-tier)
    //////////////////////////////////////////////////////////////*/

    /// @notice Begin an explicit two-step handoff of the caller's constitutional authority.
    /// @dev Direct multi-holder grants remain available, but the last holder can only move through
    ///      this accept step; it can never be revoked or renounced into a zero-authority state.
    function proposeConstitutionalTransfer(address successor) external onlyRole(CONSTITUTIONAL_ROLE) {
        if (successor == address(0) || successor == msg.sender) {
            revert InvalidConstitutionalSuccessor(successor);
        }
        _cancelPendingConstitutionalTransfer();
        pendingConstitutionalTransferor = msg.sender;
        pendingConstitutionalSuccessor = successor;
        emit ConstitutionalTransferProposed(msg.sender, successor);
    }

    /// @notice Cancel the pending handoff. Any live constitutional holder may stop a stale proposal.
    function cancelConstitutionalTransfer() external onlyRole(CONSTITUTIONAL_ROLE) {
        if (pendingConstitutionalTransferor == address(0)) revert NoPendingConstitutionalTransfer();
        _cancelPendingConstitutionalTransfer();
    }

    /// @notice Accept the pending handoff, atomically granting the successor before removing the
    ///         proposing holder.
    function acceptConstitutionalTransfer() external {
        address successor = pendingConstitutionalSuccessor;
        if (msg.sender != successor) {
            revert NotPendingConstitutionalSuccessor(msg.sender, successor);
        }
        address transferor = pendingConstitutionalTransferor;
        if (!hasRole(CONSTITUTIONAL_ROLE, transferor)) {
            revert ConstitutionalTransferorLostRole(transferor);
        }

        delete pendingConstitutionalTransferor;
        delete pendingConstitutionalSuccessor;
        _grantRole(CONSTITUTIONAL_ROLE, successor);
        _revokeRole(CONSTITUTIONAL_ROLE, transferor);
        emit ConstitutionalTransferAccepted(transferor, successor);
    }

    /// @dev Track constitutional membership at the one mutation seam used by AccessControl and
    ///      constructor/factory handoffs.
    function _grantRole(bytes32 role, address account) internal override returns (bool granted) {
        if (role == CONSTITUTIONAL_ROLE && account == address(0)) revert ZeroAddress();
        granted = super._grantRole(role, account);
        if (granted && role == CONSTITUTIONAL_ROLE) constitutionalHolderCount++;
    }

    /// @dev The nonzero-holder invariant applies equally to revokeRole, renounceRole, and the
    ///      two-step helper because all three converge here.
    function _revokeRole(bytes32 role, address account) internal override returns (bool revoked) {
        if (role == CONSTITUTIONAL_ROLE && hasRole(role, account) && constitutionalHolderCount == 1) {
            revert LastConstitutionalHolder(account);
        }
        revoked = super._revokeRole(role, account);
        if (revoked && role == CONSTITUTIONAL_ROLE) {
            constitutionalHolderCount--;
            if (account == pendingConstitutionalTransferor) _cancelPendingConstitutionalTransfer();
        }
    }

    function _cancelPendingConstitutionalTransfer() internal {
        address transferor = pendingConstitutionalTransferor;
        if (transferor == address(0)) return;
        address successor = pendingConstitutionalSuccessor;
        delete pendingConstitutionalTransferor;
        delete pendingConstitutionalSuccessor;
        emit ConstitutionalTransferCancelled(transferor, successor);
    }

    /// @notice Update the proof verifier (constitutional).
    function setZkVerifier(IZkVerifier _zkVerifier) external onlyRole(CONSTITUTIONAL_ROLE) {
        if (address(_zkVerifier) == address(0)) revert ZeroAddress();
        zkVerifier = _zkVerifier;
        emit ZkVerifierUpdated(address(_zkVerifier));
    }

    /// @notice Update the accumulator before this snapshot has frozen any checkpoints.
    /// @dev Post-checkpoint rotation is deliberately forbidden in v1. It could otherwise reuse
    ///      checkpoint ids and introduce lower freeze blocks, corrupting pinned commitments and
    ///      binary-search history. Recover by deploying a new snapshot and migrating the vault
    ///      binding; a future generation-aware migration can replace this fail-closed rule.
    function setAccumulator(IAttestationAccumulator _accumulator) external onlyRole(CONSTITUTIONAL_ROLE) {
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
        emit AccumulatorUpdated(address(_accumulator));
    }

    /// @notice Update the canonical params hash (operational).
    /// @dev Takes effect at the NEXT `trigger()`, not immediately: every checkpoint is proven
    ///      under the hash pinned when its inputs froze. A rotation therefore never invalidates a
    ///      proof already being computed.
    function setParamsHash(bytes32 _paramsHash) external onlyRole(OPERATIONAL_ROLE) {
        if (_paramsHash == bytes32(0)) revert ZeroParamsHash();
        paramsHash = _paramsHash;
        emit ParamsHashUpdated(_paramsHash);
    }

    /// @notice Set (or clear) the lane-2 anchor registry (constitutional — it changes which
    ///         inputs "the graph" means, exactly like the accumulator knob).
    function setAnchorRegistry(IAnchorRegistry _anchorRegistry) external onlyRole(CONSTITUTIONAL_ROLE) {
        anchorRegistry = _anchorRegistry;
        emit AnchorRegistryUpdated(address(_anchorRegistry));
    }

    /// @notice Set the epoch schedule (constitutional; 0 disables the schedule).
    /// @dev A changed nonzero length anchors a new fixed phase at this block. Reapplying the same
    ///      value is a no-op for phase, so even governance automation cannot shift it accidentally.
    function setEpochLength(uint64 _epochLength) external onlyRole(CONSTITUTIONAL_ROLE) {
        if (_epochLength != epochLength) {
            epochLength = _epochLength;
            if (_epochLength == 0) {
                epochOriginBlock = 0;
            } else {
                uint64 origin = uint64(block.number);
                epochOriginBlock = origin;
                lastTriggerBlock = origin;
            }
            emit EpochScheduleAnchored(_epochLength, epochOriginBlock);
        }
        emit EpochLengthUpdated(_epochLength);
    }

    /// @notice Emitted when the lane-2 registry is re-pointed.
    event AnchorRegistryUpdated(address anchorRegistry);

    /// @notice Emitted when the epoch schedule changes.
    event EpochLengthUpdated(uint64 epochLength);

    /// @notice Emitted with every trigger's lane-2 snapshot.
    event AnchorsCheckpointed(uint256 indexed checkpointId, bytes32 anchorAcc, uint64 anchorCount);

    /// @notice Emitted when a consumer hook reverts during a root update. The root is still recorded;
    ///         the hook is skipped so a misbehaving consumer can never block proof submission.
    event HookFailed(uint256 indexed hookIndex, address indexed hook);

    /// @notice Trigger fired before the contract-fixed epoch boundary.
    error EpochNotElapsed(uint64 lastTriggerBlock, uint64 epochLength);

    /*///////////////////////////////////////////////////////////////
                        SNAPSHOT LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    /// @notice Freeze the current accumulator(s) as a checkpoint. Permissionless; when an epoch
    ///         schedule is set, only at or past a fixed boundary. A late trigger consumes the
    ///         boundary for its current epoch rather than moving every future boundary.
    /// @return checkpointId The id of the new checkpoint (provers watch InputsCheckpointed).
    function trigger() external returns (uint256 checkpointId) {
        if (epochLength > 0 && block.number < uint256(lastTriggerBlock) + epochLength) {
            revert EpochNotElapsed(lastTriggerBlock, epochLength);
        }

        uint64 consumedBoundary;
        if (epochLength > 0) {
            uint256 elapsedEpochs = (block.number - epochOriginBlock) / epochLength;
            consumedBoundary = uint64(uint256(epochOriginBlock) + elapsedEpochs * epochLength);
        }

        // Refuse to freeze a checkpoint identical to the last one, across BOTH lanes.
        //
        // `AttestationAccumulator` has always refused this for lane 1 (`NoNewInputs`), but the two
        // other lane-1 seams deliberately do not: `TrustAccumulatorMirror` must let a contributions
        // round close while the vouch graph is quiet, and `EmptyLaneAccumulator`'s lane 1 is the
        // constant zero pair. On those, `trigger()` could mint an unlimited run of checkpoints with
        // byte-identical commitments — and the journal digest does not include the checkpoint id,
        // so ONE proof verifies against every one of them. That is a bounty paid repeatedly for a
        // single piece of work, and a stale root re-filed at ever-later blocks as if its inputs
        // were fresh.
        //
        // Checking here rather than in each accumulator is what makes it total: `trigger()` is the
        // only minter (the accumulators are bound to their snapshot), and it is the only place that
        // sees both lanes. "Nothing this instance reads has moved" is exactly the right condition,
        // and it is also why the mirror's missing guard was correct — lane 1 alone was never the
        // question.
        if (hasCheckpoints()) {
            IAttestationAccumulator.Checkpoint memory prev =
                accumulator.getCheckpoint(accumulator.checkpointCount() - 1);
            AnchorCheckpoint memory prevAnchor = anchorCheckpoints[accumulator.checkpointCount() - 1];
            (bytes32 liveAnchorAcc, uint64 liveAnchorCount) = _liveAnchors();
            if (
                accumulator.acc() == prev.acc && accumulator.leafCount() == prev.leafCount
                    && liveAnchorAcc == prevAnchor.anchorAcc && liveAnchorCount == prevAnchor.anchorCount
            ) {
                revert IAttestationAccumulator.NoNewInputs();
            }
        }

        lastTriggerBlock = epochLength == 0 ? uint64(block.number) : consumedBoundary;

        checkpointId = accumulator.checkpoint();
        uint256 expectedCheckpointId = nextCheckpointId;
        if (checkpointId != expectedCheckpointId) {
            revert UnexpectedCheckpointId(expectedCheckpointId, checkpointId);
        }
        nextCheckpointId = expectedCheckpointId + 1;

        // Pin the params this checkpoint must be proven under, at the block its inputs froze.
        checkpointParamsHash[checkpointId] = paramsHash;
        emit CheckpointParamsPinned(checkpointId, paramsHash);

        // Checkpoint BOTH lanes at the same boundary (OFFCHAIN doc §4). No registry ⇒ the empty
        // lane is the zero accumulator, which is exactly what the lane-1-only guest commits.
        {
            (bytes32 a, uint64 n) = _liveAnchors();
            if (a != bytes32(0) || n != 0) {
                anchorCheckpoints[checkpointId] = AnchorCheckpoint({anchorAcc: a, anchorCount: n});
            }
        }
        AnchorCheckpoint memory ac = anchorCheckpoints[checkpointId];
        emit AnchorsCheckpointed(checkpointId, ac.anchorAcc, ac.anchorCount);
        emit SnapshotTriggered(checkpointId);
    }

    /// @notice Submit a ZK proof that `outputRoot == PageRank(checkpoint inputs, params)` and write
    ///         the resulting snapshot. Permissionless: anyone who can produce a valid proof may post.
    /// @param checkpointId The checkpoint whose inputs the proof consumes.
    /// @param outputRoot The scored merkle root.
    /// @param ipfsHash The digest of the canonical scored blob.
    /// @param ipfsHashCid The CID string pointing at that blob.
    /// @param totalValue The summed points.
    /// @param skippedDigest The guest's rule-Φ/deterministic-skip commitment (proven output;
    ///        bytes32(0) when nothing was skipped or the instance has no lane 2).
    /// @param recipient The bounty payee the guest committed. Bound into the digest, so a proof
    ///        naming payee A cannot be replayed naming payee B. Zero is legitimate: it means the
    ///        root carries no bounty (a curated instance, or a community self-proving).
    /// @param proof The verifier-specific proof blob.
    function submitProof(
        uint256 checkpointId,
        bytes32 outputRoot,
        bytes32 ipfsHash,
        string calldata ipfsHashCid,
        uint256 totalValue,
        bytes32 skippedDigest,
        address recipient,
        bytes calldata proof
    ) external {
        // Monotonic: an older (or equal) checkpoint cannot clobber a newer applied one.
        if (hasAppliedCheckpoint && checkpointId <= lastAppliedCheckpoint) {
            revert StaleCheckpoint(checkpointId, lastAppliedCheckpoint);
        }

        // Reverts if checkpointId is out of range.
        IAttestationAccumulator.Checkpoint memory c = accumulator.getCheckpoint(checkpointId);
        AnchorCheckpoint memory ac = anchorCheckpoints[checkpointId];

        // The params this checkpoint froze under, NOT the current ones (see `checkpointParamsHash`).
        bytes32 pinnedParamsHash = checkpointParamsHash[checkpointId];
        if (pinnedParamsHash == bytes32(0)) revert UnpinnedCheckpoint(checkpointId);

        // The journal is the ENTIRE ABI between contract and guest (journal v3 — two-lane plus the
        // two v3 bindings, field order FROZEN, golden-locked four ways). Bind all of it — including
        // the CID *string* consumers fetch by, whose 32-byte digest alone is otherwise unproven.
        // Checkpointed storage pins both lanes; skippedDigest is the guest's own
        // audited-discretion output. The last two words are what the SUBMITTER cannot forge:
        // `recipient` is this call's argument, and `instanceDomain` is rebuilt here from our own
        // identity, so no program's params codec has to carry an instance-unique field for its
        // proofs to be instance-specific.
        bytes32 journalDigest = keccak256(
            abi.encode(
                c.acc, // lane-1 inputs   (chain-pinned)
                c.leafCount,
                ac.anchorAcc, // lane-2 inputs   (chain-pinned; zeros for a lane-1-only instance)
                ac.anchorCount,
                pinnedParamsHash, // which params    (pinned at this checkpoint's trigger)
                outputRoot, // scored tree
                ipfsHash, // canonical-blob digest
                keccak256(bytes(ipfsHashCid)), // ...and the CID string that points at that blob
                totalValue, // summed points
                skippedDigest, // rule-Φ audit commitment
                recipient, // v3: who the bounty is owed to
                instanceDomain() // v3: which instance, derived not accepted
            )
        );

        // Reverts on an invalid proof.
        zkVerifier.verify(proof, journalDigest);

        lastAppliedCheckpoint = checkpointId;
        hasAppliedCheckpoint = true;
        checkpointRecipient[checkpointId] = recipient;

        // File at the checkpoint's INPUT-FREEZE block, not the submission block, so "score as of
        // block N" stays honest despite permissionless, delayed, racy proving.
        _updateStateAtBlock(c.blockNumber, outputRoot, ipfsHash, ipfsHashCid, totalValue);

        emit MerkleRootUpdated(outputRoot, ipfsHash, ipfsHashCid, totalValue);
        emit MerkleProofSubmitted(checkpointId, outputRoot, msg.sender, recipient);
    }

    /// @notice Whether this instance has ever frozen a checkpoint.
    function hasCheckpoints() public view returns (bool) {
        return nextCheckpointId > 0;
    }

    /// The lane-2 state right now, or the zero pair on a lane-1-only instance.
    function _liveAnchors() internal view returns (bytes32, uint64) {
        if (address(anchorRegistry) == address(0)) return (bytes32(0), 0);
        return (anchorRegistry.anchorAcc(), anchorRegistry.anchorCount());
    }

    /// @notice This instance's journal-v3 domain separator: `keccak256(abi.encode(address(this),
    ///         block.chainid))`. Provers read it to fill the journal field; `submitProof` rebuilds
    ///         it rather than trusting an argument.
    /// @dev Universal separation. Trust-graph's params-v2 `accumulator`/`chainId` fields are now
    ///      belt-and-braces (kept: golden-locked and harmless); hypercerts, whose params carry no
    ///      instance-unique field at all, gets separation here for the first time (issue #9).
    function instanceDomain() public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid));
    }

    /// @notice Update the state at a specific (input-freeze) block, overriding any existing state
    ///         for that block.
    /// @param blockNumber The block the snapshot's inputs were frozen at.
    /// @param root The merkle root
    /// @param ipfsHash The IPFS hash
    /// @param ipfsHashCid The IPFS hash CID
    /// @param totalValue The total value of the merkle tree
    function _updateStateAtBlock(
        uint256 blockNumber,
        bytes32 root,
        bytes32 ipfsHash,
        string memory ipfsHashCid,
        uint256 totalValue
    ) internal {
        uint256 stateIndex;

        uint256 length = stateBlocks.length;
        if (length != 0 && blockNumber < stateBlocks[length - 1]) {
            revert NonMonotonicStateBlock(blockNumber, stateBlocks[length - 1]);
        }

        // If this is a new block, add it.
        if (length == 0 || stateBlocks[length - 1] != blockNumber) {
            stateIndex = length;
            blockToStateIndex[blockNumber] = stateIndex;
            stateBlocks.push(blockNumber);
        } else {
            // If this is an existing block, override the existing state.
            stateIndex = blockToStateIndex[blockNumber];
        }

        states[stateIndex] = MerkleState({
            blockNumber: blockNumber,
            timestamp: block.timestamp,
            root: root,
            ipfsHash: ipfsHash,
            ipfsHashCid: ipfsHashCid,
            totalValue: totalValue
        });

        // Call the hooks. A hook is a consumer-installed side effect (governance, signer-sync, ...);
        // it must never be able to block the core job of landing a proven root. We isolate each call
        // in try/catch with a fixed gas stipend so a reverting or gas-guzzling hook is skipped (and
        // surfaced via HookFailed) rather than reverting the whole submitProof for every consumer.
        for (uint256 i = 1; i < nextHookIndex; i++) {
            IMerkleSnapshotHook hook = hooks[i];
            if (address(hook) == address(0)) {
                continue;
            }
            try hook.onMerkleUpdate{gas: HOOK_GAS_STIPEND}(states[stateIndex]) {}
            catch {
                emit HookFailed(i, address(hook));
            }
        }
    }

    /*///////////////////////////////////////////////////////////////
                        PROOF VERIFICATION (consumers)
    //////////////////////////////////////////////////////////////*/

    /// @notice Verify a merkle proof for a given root and account
    /// @param root The merkle root
    /// @param account The account to verify the proof for
    /// @param value The value to verify
    /// @param proof The merkle proof
    /// @return valid Whether the proof is valid
    function _verifyProof(bytes32 root, address account, uint256 value, bytes32[] calldata proof)
        internal
        pure
        returns (bool)
    {
        // solhint-disable-next-line
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, value))));
        return MerkleProof.verifyCalldata(proof, root, leaf);
    }

    /// @notice Verify a merkle proof for a given account with the latest state
    function verifyProof(address account, uint256 value, bytes32[] calldata proof) public view returns (bool) {
        return _verifyProof(getLatestState().root, account, value, proof);
    }

    /// @notice Verify a merkle proof for the sender with the latest state
    function verifyMyProof(uint256 value, bytes32[] calldata proof) public view returns (bool) {
        return verifyProof(msg.sender, value, proof);
    }

    /// @notice Verify a merkle proof against the state at a specific block number
    function verifyProofAtBlock(address account, uint256 value, bytes32[] calldata proof, uint256 blockNumber)
        public
        view
        returns (bool)
    {
        MerkleState memory state = getStateAtBlock(blockNumber);
        return _verifyProof(state.root, account, value, proof);
    }

    /// @notice Verify a merkle proof for the sender against the state at a specific block number
    function verifyMyProofAtBlock(uint256 value, bytes32[] calldata proof, uint256 blockNumber)
        public
        view
        returns (bool)
    {
        return verifyProofAtBlock(msg.sender, value, proof, blockNumber);
    }

    /// @notice Verify a merkle proof against the state at a specific index
    function verifyProofAtStateIndex(address account, uint256 value, bytes32[] calldata proof, uint256 stateIndex)
        public
        view
        returns (bool)
    {
        MerkleState memory state = getStateAtIndex(stateIndex);
        return _verifyProof(state.root, account, value, proof);
    }

    /// @notice Verify a merkle proof for the sender against the state at a specific index
    function verifyMyProofAtStateIndex(uint256 value, bytes32[] calldata proof, uint256 stateIndex)
        public
        view
        returns (bool)
    {
        return verifyProofAtStateIndex(msg.sender, value, proof, stateIndex);
    }

    /*///////////////////////////////////////////////////////////////
                        STATE HISTORY (unchanged)
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IMerkleSnapshot
    function getLatestState() public view returns (MerkleState memory) {
        if (stateBlocks.length == 0) {
            revert NoMerkleStates();
        }
        return states[stateBlocks.length - 1];
    }

    /// @notice Get the state at (or before) a specific block number
    function getStateAtBlock(uint256 blockNumber) public view returns (MerkleState memory state) {
        if (stateBlocks.length == 0) {
            revert NoMerkleStates();
        }

        // If we have a direct match, return it. Since a 0 index may refer to an unset state or the first state, we need to check that the state at the direct index has the requested block number. An unset state will have a block number of 0, which is invalid.
        uint256 directIndex = blockToStateIndex[blockNumber];
        if (stateBlocks[directIndex] == blockNumber) {
            return states[directIndex];
        }

        // Binary search for the latest state at (or before) the target block
        (bool found, uint256 stateIndex) = _findStateIndexAtOrBeforeBlock(blockNumber);
        if (!found) {
            revert NoMerkleStateAtBlock(blockNumber, stateBlocks[0]);
        }
        return states[stateIndex];
    }

    /// @notice Get the state at a specific index
    function getStateAtIndex(uint256 index) public view returns (MerkleState memory state) {
        if (index >= stateBlocks.length) {
            revert NoMerkleStateAtIndex(index, stateBlocks.length);
        }
        return states[index];
    }

    /// @notice Binary search to find the state index at (or before) a given block
    function _findStateIndexAtOrBeforeBlock(uint256 blockNumber) internal view returns (bool found, uint256 index) {
        uint256 left = 0;
        uint256 right = stateBlocks.length;
        uint256 result = 0;
        bool foundResult = false;

        while (left < right) {
            uint256 mid = (left + right) / 2;
            uint256 midBlock = stateBlocks[mid];

            if (midBlock == blockNumber) {
                // Exact match found, return immediately.
                return (true, blockToStateIndex[midBlock]);
            } else if (midBlock < blockNumber) {
                result = blockToStateIndex[midBlock];
                foundResult = true;
                left = mid + 1;
            } else {
                right = mid;
            }
        }

        return (foundResult, result);
    }

    /// @notice Get the total number of states
    function getStateCount() public view returns (uint256 count) {
        return stateBlocks.length;
    }

    /// @notice Get paginated block numbers that have states
    function getStateBlocks(uint256 offset, uint256 limit) public view returns (uint256[] memory result_) {
        uint256 length = stateBlocks.length;
        if (offset >= length || limit == 0) return new uint256[](0);
        uint256 count = length - offset;
        if (limit < count) count = limit;
        uint256 end = offset + count;

        uint256[] memory result = new uint256[](count);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = stateBlocks[i];
        }
        return result;
    }

    /// @notice Get paginated states
    function getStates(uint256 offset, uint256 limit) public view returns (MerkleState[] memory result_) {
        uint256 length = stateBlocks.length;
        if (offset >= length || limit == 0) return new MerkleState[](0);
        uint256 count = length - offset;
        if (limit < count) count = limit;
        uint256 end = offset + count;

        MerkleState[] memory result = new MerkleState[](count);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = states[i];
        }
        return result;
    }

    /*///////////////////////////////////////////////////////////////
                                HOOKS
    //////////////////////////////////////////////////////////////*/

    /// @notice Add a hook
    function addHook(IMerkleSnapshotHook hook) external onlyRole(CONSTITUTIONAL_ROLE) {
        if (address(hook) == address(0)) revert ZeroAddress();
        if (hookIndex[hook] != 0) {
            revert HookAlreadyAdded();
        }

        hooks[nextHookIndex] = hook;
        hookIndex[hook] = nextHookIndex;
        nextHookIndex++;
        hookCount++;
    }

    /// @notice Remove a hook
    function removeHook(IMerkleSnapshotHook hook) external onlyRole(CONSTITUTIONAL_ROLE) {
        uint256 removedIndex = hookIndex[hook];
        if (removedIndex == 0) {
            revert HookNotAdded();
        }

        // Keep the set dense: move the last hook into the removed slot, then pop the last slot.
        // Iteration and getHooks therefore remain proportional to live hooks after arbitrary
        // governance churn instead of accumulating permanent tombstone SLOADs.
        uint256 lastIndex = nextHookIndex - 1;
        if (removedIndex != lastIndex) {
            IMerkleSnapshotHook movedHook = hooks[lastIndex];
            hooks[removedIndex] = movedHook;
            hookIndex[movedHook] = removedIndex;
        }

        delete hooks[lastIndex];
        delete hookIndex[hook];
        nextHookIndex = uint64(lastIndex);
        hookCount--;
    }

    /// @notice List all hooks
    function getHooks() external view returns (IMerkleSnapshotHook[] memory) {
        IMerkleSnapshotHook[] memory result = new IMerkleSnapshotHook[](hookCount);
        for (uint256 i = 1; i < nextHookIndex; i++) {
            result[i - 1] = hooks[i];
        }
        return result;
    }
}
