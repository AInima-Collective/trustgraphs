// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title AnchorRegistry
/// @notice Lane-2 input commitment (OFFCHAIN_ATTESTATIONS_ZK §4.1): an ordered, chained-hash log of
///         per-identity head anchors — the `AttestationAccumulator` pattern lifted one level up. The
///         registry does not parse envelopes or resolve which head wins — the guest
///         deterministically reconciles the log (invalid anchors are provably skippable; the head
///         with the highest owner-signed count wins). For ADDRESS-kind nodes ingress verifies the
///         owner's co-signature over `(head, count)` and enforces strictly increasing counts
///         (H-5, 2026-08-13 audit): anyone may still anchor anyone's head — heads are
///         self-certifying, so a third party can only relay the owner's newest, never forge or
///         replay a stale one; permissionless direct anchoring remains the force-inclusion hatch.
/// @dev One registry per instance (each graph owns its anchor log; sharing would couple epoch
///      schedules and registration gates across graphs for no benefit — MULTI_PROGRAM_PLATFORM §4).
contract AnchorRegistry is AccessControl {
    /// @notice May register non-address node kinds (per-instance gate, e.g. a PDS allowlist
    ///         steward at the hypercerts pilot); held by the operational timelock.
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    /// @notice Node kind 0: an Ethereum address. `nodeId = keccak256(abi.encode(address))`;
    ///         self-registration by a tx from that address. Other kinds (e.g. 1: DID) register
    ///         through REGISTRAR_ROLE until/unless a permissionless rule activates by governance.
    uint8 public constant NODE_KIND_ADDRESS = 0;

    /// @notice Frozen envelope-0 head-signature domain tag:
    ///         `keccak256("TRUSTGRAPH_ENVELOPE0_HEAD_V1")` (must match
    ///         `envelopes::eas_offchain::head_domain_tag`).
    bytes32 public constant HEAD_DOMAIN_TAG = keccak256("TRUSTGRAPH_ENVELOPE0_HEAD_V1");

    /// @notice The running fold: `anchorAcc' = keccak256(abi.encode(anchorAcc, leaf))`, acc_0 = 0 —
    ///         the same primitive as lane 1's `AttestationAccumulator`.
    bytes32 public anchorAcc;

    /// @notice Number of anchors folded so far (the leaf's position is its fold index).
    uint64 public anchorCount;

    /// @notice Registration gates junk-anchor griefing (proving cost scales with anchor count).
    mapping(bytes32 nodeId => bool) public registered;

    /// @notice The node kind recorded at registration (0 = address, 1 = DID, ...).
    mapping(bytes32 nodeId => uint8 kind) public nodeKind;

    /// @notice For address-kind nodes: the address that self-registered (the head signer the
    ///         ingress check recovers against). Zero for other kinds.
    mapping(bytes32 nodeId => address owner) public ownerOf;

    /// @notice H-5: the highest head count anchored per node. Ingress requires strictly
    ///         increasing counts for address-kind nodes, so a stale head (whose owner-signed
    ///         count is below a head already anchored) can never re-enter the log.
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

    error NotRegistered(bytes32 nodeId);
    error AlreadyRegistered(bytes32 nodeId);
    error WrongNodeId(bytes32 nodeId, address sender);
    error AddressKindIsSelfRegisterOnly();
    error StaleHeadCount(bytes32 nodeId, uint64 count, uint64 lastAnchored);
    error BadHeadSignature(bytes32 nodeId);

    /// @param admin Authority over REGISTRAR_ROLE (the operational timelock).
    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
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

    /// @notice Fold an anchor claim into the log. Permissionless for registered nodes; anyone may
    ///         RELAY a head, but for address-kind nodes ingress verifies the owner's co-signature
    ///         over `(head, count)` and requires a strictly increasing count (H-5) — so a third
    ///         party can only relay the owner's newest heads, never replay a stale one. The guest
    ///         still owns full envelope semantics and independently re-verifies the signature and
    ///         re-ranks by signed count, so soundness does not rest on this ingress check.
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
    ) external {
        if (!registered[nodeId]) revert NotRegistered(nodeId);
        if (nodeKind[nodeId] == NODE_KIND_ADDRESS) {
            // H-5 ingress: strictly increasing signed counts per node.
            if (count <= lastCount[nodeId]) revert StaleHeadCount(nodeId, count, lastCount[nodeId]);
            bytes32 payload = keccak256(abi.encode(HEAD_DOMAIN_TAG, head, count));
            address signer =
                ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(payload), headSignature);
            if (signer != ownerOf[nodeId]) revert BadHeadSignature(nodeId);
            lastCount[nodeId] = count;
        }
        // Leaf format is FROZEN and golden-locked four ways (zk_core::anchor::anchor_leaf).
        bytes32 leaf = keccak256(abi.encode(nodeId, envelopeKind, head, count, dataCommitment, block.timestamp));
        anchorAcc = keccak256(abi.encode(anchorAcc, leaf));
        emit HeadAnchored(anchorCount++, nodeId, envelopeKind, head, count, dataCommitment, block.timestamp);
    }
}
