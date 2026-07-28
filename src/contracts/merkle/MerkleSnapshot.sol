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
/// @notice Merkle-root snapshotter for TrustGraph. The `{account => score}` root is produced by a
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
    ///         When set, trigger() only fires once the boundary has passed — epoch boundaries are
    ///         never prover-chosen (OFFCHAIN doc §4.1).
    uint64 public epochLength;

    /// @notice The block at which the last scheduled trigger fired.
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

    /// @notice Array of contracts to execute when the merkle state is updated.
    mapping(uint256 hookIndex => IMerkleSnapshotHook hook) public hooks;
    /// @notice Mapping from hook to hook index for efficient removal.
    mapping(IMerkleSnapshotHook hook => uint256 hookIndex) public hookIndex;
    /// @notice The next hook index to use. Start at 1 since 0 is the default value in the mappings above.
    uint64 public nextHookIndex = 1;
    /// @notice The number of hooks.
    uint64 public hookCount;

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
        if (address(_zkVerifier) == address(0) || address(_accumulator) == address(0)) {
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

    /// @notice Update the proof verifier (constitutional).
    function setZkVerifier(IZkVerifier _zkVerifier) external onlyRole(CONSTITUTIONAL_ROLE) {
        if (address(_zkVerifier) == address(0)) revert ZeroAddress();
        zkVerifier = _zkVerifier;
        emit ZkVerifierUpdated(address(_zkVerifier));
    }

    /// @notice Update the accumulator (constitutional).
    function setAccumulator(IAttestationAccumulator _accumulator) external onlyRole(CONSTITUTIONAL_ROLE) {
        if (address(_accumulator) == address(0)) revert ZeroAddress();
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
    function setEpochLength(uint64 _epochLength) external onlyRole(CONSTITUTIONAL_ROLE) {
        epochLength = _epochLength;
        emit EpochLengthUpdated(_epochLength);
    }

    /// @notice Emitted when the lane-2 registry is re-pointed.
    event AnchorRegistryUpdated(address anchorRegistry);

    /// @notice Emitted when the epoch schedule changes.
    event EpochLengthUpdated(uint64 epochLength);

    /// @notice Emitted with every trigger's lane-2 snapshot.
    event AnchorsCheckpointed(uint256 indexed checkpointId, bytes32 anchorAcc, uint64 anchorCount);

    /// @notice Trigger fired before the contract-fixed epoch boundary.
    error EpochNotElapsed(uint64 lastTriggerBlock, uint64 epochLength);

    /*///////////////////////////////////////////////////////////////
                        SNAPSHOT LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    /// @notice Freeze the current accumulator(s) as a checkpoint. Permissionless; when an epoch
    ///         schedule is set, only past the contract-fixed boundary (never prover-chosen).
    /// @return checkpointId The id of the new checkpoint (provers watch InputsCheckpointed).
    function trigger() external returns (uint256 checkpointId) {
        if (epochLength > 0 && block.number < uint256(lastTriggerBlock) + epochLength) {
            revert EpochNotElapsed(lastTriggerBlock, epochLength);
        }
        lastTriggerBlock = uint64(block.number);

        checkpointId = accumulator.checkpoint();

        // Pin the params this checkpoint must be proven under, at the block its inputs froze.
        checkpointParamsHash[checkpointId] = paramsHash;
        emit CheckpointParamsPinned(checkpointId, paramsHash);

        // Checkpoint BOTH lanes at the same boundary (OFFCHAIN doc §4). No registry ⇒ the empty
        // lane is the zero accumulator, which is exactly what the lane-1-only guest commits.
        if (address(anchorRegistry) != address(0)) {
            anchorCheckpoints[checkpointId] =
                AnchorCheckpoint({anchorAcc: anchorRegistry.anchorAcc(), anchorCount: anchorRegistry.anchorCount()});
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

        // File at the checkpoint's INPUT-FREEZE block, not the submission block, so "score as of
        // block N" stays honest despite permissionless, delayed, racy proving.
        _updateStateAtBlock(c.blockNumber, outputRoot, ipfsHash, ipfsHashCid, totalValue);

        emit MerkleRootUpdated(outputRoot, ipfsHash, ipfsHashCid, totalValue);
        emit MerkleProofSubmitted(checkpointId, outputRoot, msg.sender, recipient);
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

        // If this is a new block, add it.
        if (stateBlocks.length == 0 || stateBlocks[stateBlocks.length - 1] != blockNumber) {
            stateIndex = stateBlocks.length;
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

        // Call the hooks.
        for (uint256 i = 1; i < nextHookIndex; i++) {
            if (address(hooks[i]) == address(0)) {
                continue;
            }
            hooks[i].onMerkleUpdate(states[stateIndex]);
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
        uint256 end = offset + limit;
        if (end > stateBlocks.length) {
            end = stateBlocks.length;
        }

        uint256[] memory result = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = stateBlocks[i];
        }
        return result;
    }

    /// @notice Get paginated states
    function getStates(uint256 offset, uint256 limit) public view returns (MerkleState[] memory result_) {
        uint256 end = offset + limit;
        if (end > stateBlocks.length) {
            end = stateBlocks.length;
        }

        MerkleState[] memory result = new MerkleState[](end - offset);
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
        if (hookIndex[hook] == 0) {
            revert HookNotAdded();
        }

        delete hooks[hookIndex[hook]];
        delete hookIndex[hook];
        hookCount--;
    }

    /// @notice List all hooks
    function getHooks() external view returns (IMerkleSnapshotHook[] memory) {
        IMerkleSnapshotHook[] memory result = new IMerkleSnapshotHook[](hookCount);
        uint256 resultIndex = 0;
        for (uint256 i = 1; i < nextHookIndex; i++) {
            if (address(hooks[i]) == address(0)) {
                continue;
            }
            result[resultIndex] = hooks[i];
            resultIndex++;
        }
        return result;
    }
}
