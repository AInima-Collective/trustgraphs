// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {InputCapacity} from "src/limits/InputCapacity.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IAnchorRegistrySnapshotView} from "interfaces/registry/IAnchorRegistrySnapshotView.sol";

/// @title AnchorRegistry
/// @notice Lane-2 input commitment (OFFCHAIN_ATTESTATIONS_ZK §4.1): an ordered, chained-hash log of
///         per-identity head anchors — the `AttestationAccumulator` pattern lifted one level up. The
///         registry does not parse envelopes or resolve which head wins — the guest
///         deterministically reconciles the log (invalid anchors are provably skippable; the head
///         with the highest owner-signed count wins). For ADDRESS-kind nodes ingress verifies the
///         owner's co-signature over `(head, count)` and enforces strictly increasing counts
///         (H-5, 2026-08-13 audit): an admitted third party may relay the owner's newest head but
///         cannot forge or replay a stale one. Only governance-admitted relayers may append:
///         self-certifying heads preserve correctness, while the relayer gate prevents an
///         unaffiliated address from changing another instance's proving cost.
/// @dev One registry per instance (each graph owns its anchor log; sharing would couple epoch
///      schedules and registration gates across graphs for no benefit — MULTI_PROGRAM_PLATFORM §4).
contract AnchorRegistry is AccessControl {
    /// @notice May register non-address node kinds (per-instance gate, e.g. a PDS allowlist
    ///         steward at the hypercerts pilot); held by the operational timelock.
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    /// @notice May relay authenticated heads into this instance's proving input log.
    /// @dev Held by a governed relayer set. Registration alone never grants it, so cheaply creating
    ///      address identities cannot inflate the fee band or consume proving capacity.
    bytes32 public constant ANCHORER_ROLE = keccak256("ANCHORER_ROLE");

    /// @notice Absolute input ceiling shared with ProvingVault and the operator policy.
    uint64 public constant ABSOLUTE_MAX_TOTAL_INPUTS = InputCapacity.MAX_TOTAL_INPUTS;

    /// @notice Node kind 0: an Ethereum address. `nodeId = keccak256(abi.encode(address))`;
    ///         self-registration by a tx from that address. Other kinds (e.g. 1: DID) register
    ///         through REGISTRAR_ROLE until/unless a permissionless rule activates by governance.
    uint8 public constant NODE_KIND_ADDRESS = 0;
    /// @notice Node kind 2: `did:nostr:<32-byte x-only pubkey>`.
    uint8 public constant NODE_KIND_NOSTR = 2;
    /// @notice Node kind 3: one pinned Buzz workspace/community UUID.
    uint8 public constant NODE_KIND_BUZZ_COMMUNITY = 3;

    /// @notice Frozen envelope-0 head-signature domain tag:
    ///         `keccak256("TRUSTGRAPH_ENVELOPE0_HEAD_V1")` (must match
    ///         `envelopes::eas_offchain::head_domain_tag`).
    bytes32 public constant HEAD_DOMAIN_TAG = keccak256("TRUSTGRAPH_ENVELOPE0_HEAD_V1");

    /// @notice The running fold: `anchorAcc' = keccak256(abi.encode(anchorAcc, leaf))`, acc_0 = 0 —
    ///         the same primitive as lane 1's `AttestationAccumulator`.
    bytes32 public anchorAcc;

    /// @notice Number of anchors folded so far (the leaf's position is its fold index).
    uint64 public anchorCount;

    /// @notice Deployer allowed to perform the reciprocal snapshot binding exactly once.
    address public immutable binder;

    /// @notice Snapshot whose live lane-1 count participates in the ingress bound.
    IAnchorRegistrySnapshotView public snapshot;

    /// @notice Immutable combined-count boundary checked before every anchor append.
    /// @dev Must not exceed the vault/operator ceiling. This contract can reject only lane-2
    ///      ingress; deployments with a mutable lane 1 must budget and control that path separately.
    uint64 public immutable maxTotalInputs;

    /// @notice Registration gates junk-anchor griefing (proving cost scales with anchor count).
    mapping(bytes32 nodeId => bool) public registered;

    /// @notice The node kind recorded at registration (0 = address, 1 = DID, ...).
    mapping(bytes32 nodeId => uint8 kind) public nodeKind;

    /// @notice For address-kind nodes: the address that self-registered (the head signer the
    ///         ingress check recovers against). Zero for other kinds.
    mapping(bytes32 nodeId => address owner) public ownerOf;

    /// @notice Highest head count anchored per node. Every admitted envelope must advance it, so a
    ///         relayer bug cannot spend finite proving capacity replaying an unchanged head.
    mapping(bytes32 nodeId => uint64 count) public lastCount;

    /// @notice Every anchor, in fold order. `foldIndex` is the leaf's position in the chain.
    event HeadAnchored(
        uint64 indexed foldIndex,
        bytes32 indexed nodeId,
        uint8 envelopeKind,
        bytes32 head,
        uint64 count,
        bytes32 dataCommitment,
        uint256 blockTimestamp
    );

    /// @notice A node joined the registry.
    event NodeRegistered(bytes32 indexed nodeId, uint8 kind, address registrant);

    /// @notice The one snapshot whose authenticated lane-1 count bounds this registry.
    event SnapshotBound(address indexed snapshot, address indexed accumulator, uint64 maxTotalInputs);

    error NotRegistered(bytes32 nodeId);
    error AlreadyRegistered(bytes32 nodeId);
    error WrongNodeId(bytes32 nodeId, address sender);
    error AddressKindIsSelfRegisterOnly();
    error StaleHeadCount(bytes32 nodeId, uint64 count, uint64 lastAnchored);
    error BadHeadSignature(bytes32 nodeId);
    error ZeroAddress();
    error InvalidInputCapacity(uint64 proposed, uint64 absoluteMaximum);
    error NotBinder(address caller);
    error SnapshotAlreadyBound(address snapshot);
    error SnapshotRegistryMismatch(address snapshot, address expected, address actual);
    error SnapshotNotBound();
    error InputCapacityExceeded(uint64 leafCount, uint64 anchorCount, uint64 maxTotalInputs);

    /// @param admin Authority over REGISTRAR_ROLE (the operational timelock).
    /// @param _maxTotalInputs Immutable ceiling over both lanes; never above the proving boundary.
    constructor(address admin, uint64 _maxTotalInputs) {
        if (admin == address(0)) revert ZeroAddress();
        if (_maxTotalInputs == 0 || _maxTotalInputs > ABSOLUTE_MAX_TOTAL_INPUTS) {
            revert InvalidInputCapacity(_maxTotalInputs, ABSOLUTE_MAX_TOTAL_INPUTS);
        }
        binder = msg.sender;
        maxTotalInputs = _maxTotalInputs;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
        _grantRole(ANCHORER_ROLE, admin);
    }

    /// @notice Bind the registry to the snapshot that points back to it.
    /// @dev The registry reads the snapshot's live accumulator on every append. A pre-checkpoint
    ///      accumulator change therefore cannot make ingress and checkpoint pricing count
    ///      different lane-1 sources.
    function bindSnapshot(address _snapshot) external {
        if (msg.sender != binder) revert NotBinder(msg.sender);
        if (address(snapshot) != address(0)) revert SnapshotAlreadyBound(address(snapshot));
        if (_snapshot == address(0)) revert ZeroAddress();

        IAnchorRegistrySnapshotView candidate = IAnchorRegistrySnapshotView(_snapshot);
        address actualRegistry = candidate.anchorRegistry();
        if (actualRegistry != address(this)) {
            revert SnapshotRegistryMismatch(_snapshot, address(this), actualRegistry);
        }
        address lane1 = candidate.accumulator();
        if (lane1 == address(0)) revert ZeroAddress();

        snapshot = candidate;
        emit SnapshotBound(_snapshot, lane1, maxTotalInputs);
    }

    /// @notice Self-registration for address nodes: the tx itself is the binding proof.
    function register() external {
        bytes32 nodeId = keccak256(abi.encode(msg.sender));
        if (registered[nodeId]) revert AlreadyRegistered(nodeId);
        registered[nodeId] = true;
        nodeKind[nodeId] = NODE_KIND_ADDRESS;
        ownerOf[nodeId] = msg.sender;
        emit NodeRegistered(nodeId, NODE_KIND_ADDRESS, msg.sender);
    }

    /// @notice Gated registration for non-address node kinds (DIDs etc.). The gate policy —
    ///         PDS allowlist, invited-by, bond — lives with the registrar, not in this contract.
    function registerNode(bytes32 nodeId, uint8 kind) external onlyRole(REGISTRAR_ROLE) {
        // Address nodes bind by a tx from the address (register()); a registrar must not be able
        // to mint an "address-kind" node whose id matches no real address.
        if (kind == NODE_KIND_ADDRESS) revert AddressKindIsSelfRegisterOnly();
        if (registered[nodeId]) revert AlreadyRegistered(nodeId);
        registered[nodeId] = true;
        nodeKind[nodeId] = kind;
        emit NodeRegistered(nodeId, kind, msg.sender);
    }

    /// @notice Fold an anchor claim into the log through a governance-admitted relayer. For
    ///         address-kind nodes ingress verifies the owner's co-signature over `(head, count)`
    ///         and requires a strictly increasing count (H-5), so a relayer can only submit the
    ///         owner's newest heads, never forge or replay a stale one. The guest still owns full
    ///         envelope semantics and independently re-verifies the signature and re-ranks by
    ///         signed count, so soundness does not rest on this ingress check.
    /// @param nodeId keccak256 of the canonical node identity (address or DID string).
    /// @param envelopeKind 0 = EAS-offchain chained log, 1 = atproto repo commit, ...
    /// @param head The per-identity completeness commitment (log head / commit CID digest).
    /// @param count The head's signed monotonic position (envelope 0: the chained-log length the
    ///        owner co-signed with the head).
    /// @param dataCommitment Where the data behind the head verifiably lives (blob versioned hash,
    ///        namespace commitment, or content root — availability-as-anchor-validity, §7).
    /// @param headSignature 65-byte EIP-191 signature by the node owner over
    ///        `keccak256(abi.encode(HEAD_DOMAIN_TAG, head, uint64 count))`. Checked for
    ///        address-kind nodes; ignored for other kinds (their gate is the registrar and their
    ///        head authentication lives in the envelope semantics).
    function anchor(
        bytes32 nodeId,
        uint8 envelopeKind,
        bytes32 head,
        uint64 count,
        bytes32 dataCommitment,
        bytes calldata headSignature
    ) external onlyRole(ANCHORER_ROLE) {
        if (address(snapshot) == address(0)) revert SnapshotNotBound();
        uint64 lane1Count = IAttestationAccumulator(snapshot.accumulator()).leafCount();
        uint64 currentAnchorCount = anchorCount;
        if (uint256(lane1Count) + currentAnchorCount >= maxTotalInputs) {
            revert InputCapacityExceeded(lane1Count, currentAnchorCount, maxTotalInputs);
        }
        if (!registered[nodeId]) revert NotRegistered(nodeId);
        uint64 previousCount = lastCount[nodeId];
        if (count <= previousCount) revert StaleHeadCount(nodeId, count, previousCount);
        if (nodeKind[nodeId] == NODE_KIND_ADDRESS) {
            bytes32 payload = keccak256(abi.encode(HEAD_DOMAIN_TAG, head, count));
            address signer = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(payload), headSignature);
            if (signer != ownerOf[nodeId]) revert BadHeadSignature(nodeId);
        }
        lastCount[nodeId] = count;
        // Leaf format is FROZEN and golden-locked four ways (zk_core::anchor::anchor_leaf).
        bytes32 leaf = keccak256(abi.encode(nodeId, envelopeKind, head, count, dataCommitment, block.timestamp));
        anchorAcc = keccak256(abi.encode(anchorAcc, leaf));
        emit HeadAnchored(anchorCount++, nodeId, envelopeKind, head, count, dataCommitment, block.timestamp);
    }
}
