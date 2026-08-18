// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IGraphLineageRegistry
/// @notice Canonical graph identities and advisory, authority-authenticated endorsements.
interface IGraphLineageRegistry {
    enum EndorsementKind {
        Integrity,
        Methodology,
        Referral,
        Agreement,
        Warning
    }

    enum EndorsementStatus {
        Unknown,
        Active,
        WrongScope,
        WrongSubjectConfiguration,
        Revoked,
        Superseded,
        NotStarted,
        Expired,
        IssuerConfigurationRotated,
        SubjectConfigurationRotated
    }

    struct Lineage {
        bytes32 instanceId;
        bytes32 familyId;
        bytes32 currentConfigurationId;
        uint64 currentVersion;
        string displayName;
        string metadataURI;
        bool exists;
    }

    struct Configuration {
        bytes32 lineageId;
        uint64 version;
        bytes32 programId;
        address snapshot;
        address verifier;
        address registryOrAccumulator;
        bytes32 paramsHash;
        address controller;
        address authority;
        bytes32 familyId;
        bytes32 methodId;
        bytes32 scopeHash;
        bytes32 identityDomain;
        bytes32 sourceLineagePolicyHash;
        uint48 activatedAt;
    }

    struct Epoch {
        bytes32 lineageId;
        bytes32 configurationId;
        uint64 configurationVersion;
        uint256 checkpointId;
        uint256 freezeBlock;
        uint256 acceptedAtBlock;
        bytes32 root;
        bytes32 blobSha256;
        bytes32 cidDigest;
        string cid;
        uint256 totalValue;
        bytes32 programVKey;
        bool exists;
    }

    struct EndorsementInput {
        bytes32 issuerLineageId;
        bytes32 subjectLineageId;
        bytes32 subjectConfigurationId;
        bytes32 scopeHash;
        EndorsementKind kind;
        uint256 weight;
        uint48 validFrom;
        uint48 validUntil;
        string evidenceURI;
        bytes32 evidenceDigest;
        uint64 sequence;
        bytes32 supersedes;
    }

    struct Endorsement {
        bytes32 issuerLineageId;
        bytes32 subjectLineageId;
        bytes32 issuerConfigurationId;
        bytes32 subjectConfigurationId;
        bytes32 scopeHash;
        EndorsementKind kind;
        uint256 weight;
        uint48 validFrom;
        uint48 validUntil;
        string evidenceURI;
        bytes32 evidenceDigest;
        uint64 sequence;
        bytes32 supersedes;
        bytes32 supersededBy;
        uint48 revokedAt;
        bytes32 revocationRef;
        bool exists;
    }

    error ZeroAddress();
    error UnknownInstance(bytes32 instanceId);
    error MissingController(bytes32 instanceId);
    error Unauthorized(address caller, address expected);
    error InvalidIdentityField();
    error InvalidTextLength(uint256 length, uint256 maximum);
    error LineageAlreadyRegistered(bytes32 lineageId);
    error UnknownLineage(bytes32 lineageId);
    error ConfigurationNotLive(bytes32 lineageId, bytes32 configurationId);
    error NoConfigurationChange(bytes32 lineageId);
    error EpochAlreadyPublished(bytes32 epochId);
    error CheckpointConfigurationMismatch(bytes32 expected, bytes32 actual);
    error CheckpointVerifierMismatch(address expected, address actual);
    error InvalidEndorsementParties();
    error SubjectConfigurationMismatch(bytes32 expected, bytes32 actual);
    error InvalidWeight(uint256 weight);
    error InvalidValidity(uint48 validFrom, uint48 validUntil);
    error ValidityTooLong(uint48 duration, uint48 maximum);
    error InvalidSequence(uint64 expected, uint64 actual);
    error InvalidSupersedes(bytes32 expected, bytes32 actual);
    error ReferralBudgetExceeded(uint256 attempted, uint256 maximum);
    error TooManyReferralSubjects(uint256 maximum);
    error UnknownEndorsement(bytes32 endorsementId);
    error AlreadyRevoked(bytes32 endorsementId);
    error InvalidRevocationReference();

    event LineageRegistered(
        bytes32 indexed lineageId,
        bytes32 indexed instanceId,
        address indexed authority,
        address controller,
        bytes32 familyId,
        string displayName,
        string metadataURI
    );
    event LineageMetadataUpdated(
        bytes32 indexed lineageId, address indexed authority, string displayName, string metadataURI
    );
    event ConfigurationActivated(
        bytes32 indexed lineageId,
        bytes32 indexed configurationId,
        uint64 indexed version,
        bytes32 programId,
        address snapshot,
        address verifier,
        address registryOrAccumulator,
        bytes32 paramsHash,
        address controller,
        address authority,
        bytes32 familyId,
        bytes32 methodId,
        bytes32 scopeHash,
        bytes32 identityDomain,
        bytes32 sourceLineagePolicyHash
    );
    event EpochPublished(
        bytes32 indexed lineageId,
        bytes32 indexed epochId,
        bytes32 indexed configurationId,
        uint64 configurationVersion,
        uint256 checkpointId,
        uint256 freezeBlock,
        uint256 acceptedAtBlock,
        bytes32 root,
        bytes32 blobSha256,
        bytes32 cidDigest,
        string cid,
        uint256 totalValue,
        bytes32 programVKey
    );
    event EndorsementIssued(
        bytes32 indexed endorsementId,
        bytes32 indexed issuerLineageId,
        bytes32 indexed subjectLineageId,
        bytes32 issuerConfigurationId,
        bytes32 subjectConfigurationId,
        bytes32 scopeHash,
        EndorsementKind kind,
        uint256 weight,
        uint48 validFrom,
        uint48 validUntil,
        string evidenceURI,
        bytes32 evidenceDigest,
        uint64 sequence,
        bytes32 supersedes
    );
    event EndorsementRevoked(
        bytes32 indexed endorsementId, bytes32 indexed issuerLineageId, bytes32 indexed revocationRef, uint48 revokedAt
    );

    function lineageIdFor(bytes32 instanceId) external view returns (bytes32);
    function registerLineage(
        bytes32 instanceId,
        bytes32 familyId,
        bytes32 methodId,
        bytes32 scopeHash,
        bytes32 identityDomain,
        bytes32 sourceLineagePolicyHash,
        string calldata displayName,
        string calldata metadataURI
    ) external returns (bytes32 lineageId, bytes32 configurationId);
    function syncConfiguration(
        bytes32 lineageId,
        bytes32 familyId,
        bytes32 methodId,
        bytes32 scopeHash,
        bytes32 identityDomain,
        bytes32 sourceLineagePolicyHash
    ) external returns (bytes32 configurationId);
    function updateMetadata(bytes32 lineageId, string calldata displayName, string calldata metadataURI) external;
    function publishEpoch(bytes32 lineageId, uint256 checkpointId) external returns (bytes32 epochId);
    function issueEndorsement(EndorsementInput calldata input) external returns (bytes32 endorsementId);
    function revokeEndorsement(bytes32 endorsementId, bytes32 revocationRef) external;
    function getLineage(bytes32 lineageId) external view returns (Lineage memory);
    function getConfiguration(bytes32 configurationId) external view returns (Configuration memory);
    function getEpoch(bytes32 epochId) external view returns (Epoch memory);
    function getEndorsement(bytes32 endorsementId) external view returns (Endorsement memory);
    function configurationLive(bytes32 configurationId) external view returns (bool);
    function endorsementStatus(bytes32 endorsementId, bytes32 expectedScope, bytes32 expectedSubjectConfigurationId)
        external
        view
        returns (EndorsementStatus);
    function activeReferralSpend(bytes32 issuerLineageId, bytes32 scopeHash)
        external
        view
        returns (uint256 spent, uint256 unused);
    function referralClaimKeys(bytes32 issuerLineageId, bytes32 scopeHash) external view returns (bytes32[] memory);
}
