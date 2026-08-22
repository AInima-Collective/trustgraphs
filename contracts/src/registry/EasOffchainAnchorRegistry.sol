// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IEAS} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {InputCapacity} from "src/limits/InputCapacity.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IAnchorRegistrySnapshotView} from "interfaces/registry/IAnchorRegistrySnapshotView.sol";

/// @title EasOffchainAnchorRegistry
/// @notice Strict, work-bounded envelope-0 ingress for gasless EAS v2 Trustgraphs vouches.
/// @dev The registry validates only the owner-authorized append transition and its public work
///      bound. The SP1 guest independently checks the exact payload bytes, every EAS signature,
///      every historical prefix, and cross-lane reconciliation.
contract EasOffchainAnchorRegistry is AccessControl {
    bytes32 public constant ANCHORER_ROLE = keccak256("ANCHORER_ROLE");

    uint8 public constant ENVELOPE_KIND = 0;
    uint64 public constant MAX_ENTRIES_PER_NODE = 2_048;
    uint64 public constant E0_ENTRY_WORK_UNITS = 4;
    uint64 public constant ABSOLUTE_MAX_TOTAL_INPUTS = InputCapacity.MAX_TOTAL_INPUTS;

    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant ANCHOR_TYPEHASH = keccak256(
        "Anchor(bytes32 nodeId,uint8 envelopeKind,bytes32 schemaUid,bytes32 previousHead,bytes32 head,uint64 count,bytes32 dataCommitment)"
    );
    bytes32 private constant EAS_NAME_HASH = keccak256("EAS Attestation");
    bytes32 private constant HEAD_NAME_HASH = keccak256("Trustgraphs Offchain Head");
    bytes32 private constant HEAD_VERSION_HASH = keccak256("2");

    IEAS public immutable EAS;
    bytes32 public immutable schemaUid;
    uint64 public immutable maxTotalInputs;
    address public immutable binder;
    bytes32 public immutable easDomainSeparator;
    bytes32 public immutable headDomainSeparator;

    IAnchorRegistrySnapshotView public snapshot;
    bytes32 public anchorAcc;
    uint64 public anchorCount;
    uint64 public aggregateLatestEnvelope0EntryCount;

    mapping(bytes32 nodeId => bool) public registered;
    mapping(bytes32 nodeId => address) public ownerOf;
    mapping(bytes32 nodeId => uint64) public lastCount;
    mapping(bytes32 nodeId => bytes32) public lastHead;
    mapping(bytes32 nodeId => bytes32) public lastDataCommitment;

    event NodeRegistered(bytes32 indexed nodeId, address indexed owner);
    event HeadAnchored(
        uint64 indexed foldIndex,
        bytes32 indexed nodeId,
        address indexed owner,
        uint8 envelopeKind,
        bytes32 schemaUid,
        bytes32 previousHead,
        bytes32 head,
        uint64 count,
        bytes32 dataCommitment,
        uint256 blockTimestamp,
        bytes headSignature
    );
    event SnapshotBound(address indexed snapshot, address indexed accumulator, uint64 maxTotalInputs);

    error ZeroAddress();
    error ZeroBytes32();
    error InvalidInputCapacity(uint64 proposed, uint64 absoluteMaximum);
    error InvalidEnvelopeKind(uint8 supplied);
    error InvalidEntryCount(uint64 supplied, uint64 maximum);
    error PreviousHeadMismatch(bytes32 nodeId, bytes32 supplied, bytes32 expected);
    error StaleHeadCount(bytes32 nodeId, uint64 supplied, uint64 current);
    error SameCountConflict(bytes32 nodeId, uint64 count);
    error WrongNodeId(bytes32 supplied, bytes32 expected);
    error WrongOwner(bytes32 nodeId, address recovered, address expected);
    error NotBinder(address caller);
    error SnapshotAlreadyBound(address snapshot);
    error SnapshotRegistryMismatch(address snapshot, address expected, address actual);
    error SnapshotNotBound();
    error InputCapacityExceeded(uint64 lane1LeafCount, uint64 projectedLane2Work, uint64 maxTotalInputs);

    constructor(
        IEAS eas,
        bytes32 schemaUid_,
        uint64 maxTotalInputs_,
        address admin,
        address binder_,
        address[] memory initialRelayers
    ) {
        if (address(eas) == address(0) || admin == address(0) || binder_ == address(0)) {
            revert ZeroAddress();
        }
        if (schemaUid_ == bytes32(0)) revert ZeroBytes32();
        if (maxTotalInputs_ == 0 || maxTotalInputs_ > ABSOLUTE_MAX_TOTAL_INPUTS) {
            revert InvalidInputCapacity(maxTotalInputs_, ABSOLUTE_MAX_TOTAL_INPUTS);
        }

        EAS = eas;
        schemaUid = schemaUid_;
        maxTotalInputs = maxTotalInputs_;
        binder = binder_;
        easDomainSeparator = _domainSeparator(EAS_NAME_HASH, keccak256(bytes(eas.version())), address(eas));
        headDomainSeparator = _domainSeparator(HEAD_NAME_HASH, HEAD_VERSION_HASH, address(this));

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        for (uint256 i = 0; i < initialRelayers.length; i++) {
            address relayer = initialRelayers[i];
            if (relayer == address(0)) revert ZeroAddress();
            _grantRole(ANCHORER_ROLE, relayer);
        }
    }

    /// @notice Bind exactly once to the snapshot that already points back to this registry.
    function bindSnapshot(address snapshot_) external {
        if (msg.sender != binder) revert NotBinder(msg.sender);
        if (address(snapshot) != address(0)) revert SnapshotAlreadyBound(address(snapshot));
        if (snapshot_ == address(0)) revert ZeroAddress();

        IAnchorRegistrySnapshotView candidate = IAnchorRegistrySnapshotView(snapshot_);
        address actualRegistry = candidate.anchorRegistry();
        if (actualRegistry != address(this)) {
            revert SnapshotRegistryMismatch(snapshot_, address(this), actualRegistry);
        }
        address lane1 = candidate.accumulator();
        if (lane1 == address(0)) revert ZeroAddress();
        snapshot = candidate;
        emit SnapshotBound(snapshot_, lane1, maxTotalInputs);
    }

    /// @notice Lane-2 work units checkpointed and priced in place of raw anchor count.
    function workCount() public view returns (uint64) {
        return anchorCount + aggregateLatestEnvelope0EntryCount * E0_ENTRY_WORK_UNITS;
    }

    /// @notice Exact typed digest wallets sign for an append transition.
    function anchorDigest(
        bytes32 nodeId,
        uint8 envelopeKind,
        bytes32 previousHead,
        bytes32 head,
        uint64 count,
        bytes32 dataCommitment
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ANCHOR_TYPEHASH,
                nodeId,
                envelopeKind,
                schemaUid,
                previousHead,
                head,
                count,
                dataCommitment
            )
        );
        return MessageHashUtils.toTypedDataHash(headDomainSeparator, structHash);
    }

    /// @notice Atomically register an EOA node (on first use) and append its authorized head.
    function anchor(
        bytes32 nodeId,
        uint8 envelopeKind,
        bytes32 previousHead,
        bytes32 head,
        uint64 count,
        bytes32 dataCommitment,
        bytes calldata headSignature
    ) external onlyRole(ANCHORER_ROLE) {
        if (address(snapshot) == address(0)) revert SnapshotNotBound();
        if (envelopeKind != ENVELOPE_KIND) revert InvalidEnvelopeKind(envelopeKind);
        if (head == bytes32(0) || dataCommitment == bytes32(0)) revert ZeroBytes32();
        if (count == 0 || count > MAX_ENTRIES_PER_NODE) {
            revert InvalidEntryCount(count, MAX_ENTRIES_PER_NODE);
        }

        uint64 currentCount = lastCount[nodeId];
        if (count < currentCount) revert StaleHeadCount(nodeId, count, currentCount);
        if (count == currentCount) revert SameCountConflict(nodeId, count);
        bytes32 currentHead = lastHead[nodeId];
        if (previousHead != currentHead) {
            revert PreviousHeadMismatch(nodeId, previousHead, currentHead);
        }

        uint64 delta = count - currentCount;
        uint256 projectedEntries = uint256(aggregateLatestEnvelope0EntryCount) + delta;
        uint256 projectedWork = uint256(anchorCount) + 1 + projectedEntries * E0_ENTRY_WORK_UNITS;
        uint64 lane1Count = IAttestationAccumulator(snapshot.accumulator()).leafCount();
        if (uint256(lane1Count) + projectedWork > maxTotalInputs) {
            revert InputCapacityExceeded(lane1Count, uint64(projectedWork), maxTotalInputs);
        }

        address owner = ECDSA.recover(
            anchorDigest(nodeId, envelopeKind, previousHead, head, count, dataCommitment), headSignature
        );
        bytes32 expectedNodeId = keccak256(abi.encode(owner));
        if (nodeId != expectedNodeId) revert WrongNodeId(nodeId, expectedNodeId);
        if (registered[nodeId]) {
            address expectedOwner = ownerOf[nodeId];
            if (owner != expectedOwner) revert WrongOwner(nodeId, owner, expectedOwner);
        } else {
            registered[nodeId] = true;
            ownerOf[nodeId] = owner;
            emit NodeRegistered(nodeId, owner);
        }

        lastCount[nodeId] = count;
        lastHead[nodeId] = head;
        lastDataCommitment[nodeId] = dataCommitment;
        aggregateLatestEnvelope0EntryCount = uint64(projectedEntries);

        uint256 timestamp = block.timestamp;
        bytes32 leaf = keccak256(abi.encode(nodeId, envelopeKind, head, count, dataCommitment, timestamp));
        anchorAcc = keccak256(abi.encode(anchorAcc, leaf));
        uint64 foldIndex = anchorCount;
        anchorCount = foldIndex + 1;
        emit HeadAnchored(
            foldIndex,
            nodeId,
            owner,
            envelopeKind,
            schemaUid,
            previousHead,
            head,
            count,
            dataCommitment,
            timestamp,
            headSignature
        );
    }

    function _domainSeparator(bytes32 nameHash, bytes32 versionHash, address verifyingContract)
        private
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, nameHash, versionHash, block.chainid, verifyingContract));
    }
}
