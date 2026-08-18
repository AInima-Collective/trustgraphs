// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IGraphLineageRegistry} from "interfaces/registry/IGraphLineageRegistry.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {IMerkleSnapshotProvenance} from "interfaces/merkle/IMerkleSnapshotProvenance.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

/// @title GraphLineageRegistry
/// @notice Stable graph actors and typed evidence for the advisory graph-of-graphs experiment.
/// @dev This contract is deliberately disconnected from MerkleSnapshot scoring and proof paths.
///      Its records can recommend source policy, but cannot mutate a score, root, proof, or V1
///      trust-compose weight. Every active endorsement remains pinned to live InstanceRegistry and
///      controller-owner facts, so a rotation fails closed even before somebody records a new
///      configuration version.
contract GraphLineageRegistry is IGraphLineageRegistry {
    bytes32 public constant LINEAGE_DOMAIN = keccak256("trustgraphs.graph-lineage.v1");
    bytes32 public constant CONFIGURATION_DOMAIN = keccak256("trustgraphs.graph-configuration.v1");
    bytes32 public constant EPOCH_DOMAIN = keccak256("trustgraphs.graph-epoch.v1");
    bytes32 public constant ENDORSEMENT_DOMAIN = keccak256("trustgraphs.graph-endorsement.v1");
    uint256 public constant REFERRAL_BUDGET = 1e18;
    uint48 public constant MAX_VALIDITY = 90 days;
    uint256 public constant MAX_REFERRAL_SUBJECTS = 64;
    uint256 public constant MAX_DISPLAY_NAME_BYTES = 128;
    uint256 public constant MAX_URI_BYTES = 512;

    IInstanceRegistry public immutable instanceRegistry;

    mapping(bytes32 lineageId => Lineage) private _lineages;
    mapping(bytes32 configurationId => Configuration) private _configurations;
    mapping(bytes32 epochId => Epoch) private _epochs;
    mapping(bytes32 endorsementId => Endorsement) private _endorsements;
    mapping(bytes32 issuerScope => uint64) public latestSequence;
    mapping(bytes32 claimKey => bytes32 endorsementId) public claimHead;
    mapping(bytes32 issuerScope => bytes32[] claimKeys) private _referralClaimKeys;

    constructor(IInstanceRegistry instanceRegistry_) {
        if (address(instanceRegistry_) == address(0)) revert ZeroAddress();
        instanceRegistry = instanceRegistry_;
    }

    function lineageIdFor(bytes32 instanceId) public view returns (bytes32) {
        return keccak256(abi.encode(LINEAGE_DOMAIN, block.chainid, address(instanceRegistry), instanceId));
    }

    function registerLineage(
        bytes32 instanceId,
        bytes32 familyId,
        bytes32 methodId,
        bytes32 scopeHash,
        bytes32 identityDomain,
        bytes32 sourceLineagePolicyHash,
        string calldata displayName,
        string calldata metadataURI
    ) external returns (bytes32 lineageId, bytes32 configurationId) {
        _validateIdentityFields(familyId, methodId, scopeHash, identityDomain);
        _validateMetadata(displayName, metadataURI);
        (IInstanceRegistry.Instance memory record, address controller, address authority) = _liveIdentity(instanceId);
        if (msg.sender != authority) revert Unauthorized(msg.sender, authority);

        lineageId = lineageIdFor(instanceId);
        if (_lineages[lineageId].exists) revert LineageAlreadyRegistered(lineageId);
        _lineages[lineageId] = Lineage({
            instanceId: instanceId,
            familyId: familyId,
            currentConfigurationId: bytes32(0),
            currentVersion: 0,
            displayName: displayName,
            metadataURI: metadataURI,
            exists: true
        });
        emit LineageRegistered(lineageId, instanceId, authority, controller, familyId, displayName, metadataURI);
        configurationId = _activateConfiguration(
            lineageId,
            record,
            controller,
            authority,
            familyId,
            methodId,
            scopeHash,
            identityDomain,
            sourceLineagePolicyHash
        );
    }

    /// @notice Record the next authenticated program/config/controller/authority version.
    /// @dev The new live authority must call. Calling is not required to suspend old endorsements:
    ///      `configurationLive` compares against the underlying registries on every read.
    function syncConfiguration(
        bytes32 lineageId,
        bytes32 familyId,
        bytes32 methodId,
        bytes32 scopeHash,
        bytes32 identityDomain,
        bytes32 sourceLineagePolicyHash
    ) external returns (bytes32 configurationId) {
        Lineage storage lineage = _requireLineage(lineageId);
        _validateIdentityFields(familyId, methodId, scopeHash, identityDomain);
        (IInstanceRegistry.Instance memory record, address controller, address authority) =
            _liveIdentity(lineage.instanceId);
        if (msg.sender != authority) revert Unauthorized(msg.sender, authority);

        Configuration storage current = _configurations[lineage.currentConfigurationId];
        if (
            current.programId == record.program && current.snapshot == record.snapshot
                && current.verifier == record.verifier && current.registryOrAccumulator == record.registryOrAccumulator
                && current.paramsHash == record.paramsHash && current.controller == controller
                && current.authority == authority && current.familyId == familyId && current.methodId == methodId
                && current.scopeHash == scopeHash && current.identityDomain == identityDomain
                && current.sourceLineagePolicyHash == sourceLineagePolicyHash
        ) revert NoConfigurationChange(lineageId);

        lineage.familyId = familyId;
        configurationId = _activateConfiguration(
            lineageId,
            record,
            controller,
            authority,
            familyId,
            methodId,
            scopeHash,
            identityDomain,
            sourceLineagePolicyHash
        );
    }

    function updateMetadata(bytes32 lineageId, string calldata displayName, string calldata metadataURI) external {
        Lineage storage lineage = _requireLineage(lineageId);
        _validateMetadata(displayName, metadataURI);
        Configuration storage current = _configurations[lineage.currentConfigurationId];
        if (!_configurationLive(current)) {
            revert ConfigurationNotLive(lineageId, lineage.currentConfigurationId);
        }
        if (msg.sender != current.authority) revert Unauthorized(msg.sender, current.authority);
        lineage.displayName = displayName;
        lineage.metadataURI = metadataURI;
        emit LineageMetadataUpdated(lineageId, current.authority, displayName, metadataURI);
    }

    function publishEpoch(bytes32 lineageId, uint256 checkpointId) external returns (bytes32 epochId) {
        Lineage storage lineage = _requireLineage(lineageId);
        Configuration storage config = _configurations[lineage.currentConfigurationId];
        if (!_configurationLive(config)) {
            revert ConfigurationNotLive(lineageId, lineage.currentConfigurationId);
        }
        if (msg.sender != config.authority) revert Unauthorized(msg.sender, config.authority);

        (IMerkleSnapshot.MerkleState memory state, IMerkleSnapshotProvenance.StateProvenance memory provenance) =
            IMerkleSnapshotProvenance(config.snapshot).getAcceptedCheckpoint(checkpointId);
        if (provenance.paramsHash != config.paramsHash) {
            revert CheckpointConfigurationMismatch(config.paramsHash, provenance.paramsHash);
        }
        if (provenance.verifier != config.verifier) {
            revert CheckpointVerifierMismatch(config.verifier, provenance.verifier);
        }
        bytes32 cidDigest = keccak256(bytes(state.ipfsHashCid));
        epochId = keccak256(
            abi.encode(
                EPOCH_DOMAIN,
                lineageId,
                lineage.currentConfigurationId,
                checkpointId,
                state.blockNumber,
                state.root,
                state.ipfsHash,
                cidDigest,
                state.totalValue,
                provenance.acceptedAtBlock,
                provenance.programVKey
            )
        );
        if (_epochs[epochId].exists) revert EpochAlreadyPublished(epochId);
        _epochs[epochId] = Epoch({
            lineageId: lineageId,
            configurationId: lineage.currentConfigurationId,
            configurationVersion: lineage.currentVersion,
            checkpointId: checkpointId,
            freezeBlock: state.blockNumber,
            acceptedAtBlock: provenance.acceptedAtBlock,
            root: state.root,
            blobSha256: state.ipfsHash,
            cidDigest: cidDigest,
            cid: state.ipfsHashCid,
            totalValue: state.totalValue,
            programVKey: provenance.programVKey,
            exists: true
        });
        emit EpochPublished(
            lineageId,
            epochId,
            lineage.currentConfigurationId,
            lineage.currentVersion,
            checkpointId,
            state.blockNumber,
            provenance.acceptedAtBlock,
            state.root,
            state.ipfsHash,
            cidDigest,
            state.ipfsHashCid,
            state.totalValue,
            provenance.programVKey
        );
    }

    function issueEndorsement(EndorsementInput calldata input) external returns (bytes32 endorsementId) {
        if (input.issuerLineageId == input.subjectLineageId) revert InvalidEndorsementParties();
        Lineage storage issuer = _requireLineage(input.issuerLineageId);
        Lineage storage subject = _requireLineage(input.subjectLineageId);
        Configuration storage issuerConfig = _configurations[issuer.currentConfigurationId];
        Configuration storage subjectConfig = _configurations[subject.currentConfigurationId];
        if (!_configurationLive(issuerConfig)) {
            revert ConfigurationNotLive(input.issuerLineageId, issuer.currentConfigurationId);
        }
        if (!_configurationLive(subjectConfig)) {
            revert ConfigurationNotLive(input.subjectLineageId, subject.currentConfigurationId);
        }
        if (msg.sender != issuerConfig.authority) revert Unauthorized(msg.sender, issuerConfig.authority);
        if (input.subjectConfigurationId != subject.currentConfigurationId) {
            revert SubjectConfigurationMismatch(subject.currentConfigurationId, input.subjectConfigurationId);
        }
        if (input.scopeHash == bytes32(0)) revert InvalidIdentityField();
        if (input.weight > REFERRAL_BUDGET) revert InvalidWeight(input.weight);
        if (input.kind == EndorsementKind.Referral && input.weight == 0) revert InvalidWeight(input.weight);
        if (input.validUntil <= block.timestamp || input.validUntil <= input.validFrom) {
            revert InvalidValidity(input.validFrom, input.validUntil);
        }
        uint48 duration = input.validUntil - input.validFrom;
        if (duration > MAX_VALIDITY) revert ValidityTooLong(duration, MAX_VALIDITY);
        uint256 evidenceLength = bytes(input.evidenceURI).length;
        if (evidenceLength == 0 || evidenceLength > MAX_URI_BYTES) {
            revert InvalidTextLength(evidenceLength, MAX_URI_BYTES);
        }

        bytes32 issuerScope = _issuerScope(input.issuerLineageId, input.scopeHash);
        uint64 expectedSequence = latestSequence[issuerScope] + 1;
        if (input.sequence != expectedSequence) revert InvalidSequence(expectedSequence, input.sequence);
        bytes32 claim = _claimKey(input.issuerLineageId, input.subjectLineageId, input.scopeHash, input.kind);
        bytes32 previous = claimHead[claim];
        if (input.supersedes != previous) revert InvalidSupersedes(previous, input.supersedes);

        if (input.kind == EndorsementKind.Referral) {
            bytes32[] storage claims = _referralClaimKeys[issuerScope];
            if (previous == bytes32(0)) {
                if (claims.length >= MAX_REFERRAL_SUBJECTS) {
                    revert TooManyReferralSubjects(MAX_REFERRAL_SUBJECTS);
                }
                claims.push(claim);
            }
            uint256 attempted = _maxReferralSpendOverValidity(
                input.issuerLineageId, input.scopeHash, previous, input.validFrom, input.validUntil, input.weight
            );
            if (attempted > REFERRAL_BUDGET) revert ReferralBudgetExceeded(attempted, REFERRAL_BUDGET);
        }

        endorsementId = keccak256(
            abi.encode(
                ENDORSEMENT_DOMAIN, block.chainid, address(this), input.issuerLineageId, input.scopeHash, input.sequence
            )
        );
        _endorsements[endorsementId] = Endorsement({
            issuerLineageId: input.issuerLineageId,
            subjectLineageId: input.subjectLineageId,
            issuerConfigurationId: issuer.currentConfigurationId,
            subjectConfigurationId: subject.currentConfigurationId,
            scopeHash: input.scopeHash,
            kind: input.kind,
            weight: input.weight,
            validFrom: input.validFrom,
            validUntil: input.validUntil,
            evidenceURI: input.evidenceURI,
            evidenceDigest: input.evidenceDigest,
            sequence: input.sequence,
            supersedes: previous,
            supersededBy: bytes32(0),
            revokedAt: 0,
            revocationRef: bytes32(0),
            exists: true
        });
        if (previous != bytes32(0)) _endorsements[previous].supersededBy = endorsementId;
        claimHead[claim] = endorsementId;
        latestSequence[issuerScope] = input.sequence;
        emit EndorsementIssued(
            endorsementId,
            input.issuerLineageId,
            input.subjectLineageId,
            issuer.currentConfigurationId,
            subject.currentConfigurationId,
            input.scopeHash,
            input.kind,
            input.weight,
            input.validFrom,
            input.validUntil,
            input.evidenceURI,
            input.evidenceDigest,
            input.sequence,
            previous
        );
    }

    function revokeEndorsement(bytes32 endorsementId, bytes32 revocationRef) external {
        Endorsement storage endorsement = _endorsements[endorsementId];
        if (!endorsement.exists) revert UnknownEndorsement(endorsementId);
        if (endorsement.revokedAt != 0) revert AlreadyRevoked(endorsementId);
        if (revocationRef == bytes32(0)) revert InvalidRevocationReference();
        Lineage storage issuer = _requireLineage(endorsement.issuerLineageId);
        Configuration storage current = _configurations[issuer.currentConfigurationId];
        if (!_configurationLive(current)) {
            revert ConfigurationNotLive(endorsement.issuerLineageId, issuer.currentConfigurationId);
        }
        if (msg.sender != current.authority) revert Unauthorized(msg.sender, current.authority);
        endorsement.revokedAt = uint48(block.timestamp);
        endorsement.revocationRef = revocationRef;
        emit EndorsementRevoked(endorsementId, endorsement.issuerLineageId, revocationRef, uint48(block.timestamp));
    }

    function getLineage(bytes32 lineageId) external view returns (Lineage memory) {
        return _lineages[lineageId];
    }

    function getConfiguration(bytes32 configurationId) external view returns (Configuration memory) {
        return _configurations[configurationId];
    }

    function getEpoch(bytes32 epochId) external view returns (Epoch memory) {
        return _epochs[epochId];
    }

    function getEndorsement(bytes32 endorsementId) external view returns (Endorsement memory) {
        return _endorsements[endorsementId];
    }

    function configurationLive(bytes32 configurationId) external view returns (bool) {
        return _configurationLive(_configurations[configurationId]);
    }

    function endorsementStatus(bytes32 endorsementId, bytes32 expectedScope, bytes32 expectedSubjectConfigurationId)
        public
        view
        returns (EndorsementStatus)
    {
        Endorsement storage endorsement = _endorsements[endorsementId];
        if (!endorsement.exists) return EndorsementStatus.Unknown;
        if (expectedScope != bytes32(0) && endorsement.scopeHash != expectedScope) {
            return EndorsementStatus.WrongScope;
        }
        if (
            expectedSubjectConfigurationId != bytes32(0)
                && endorsement.subjectConfigurationId != expectedSubjectConfigurationId
        ) return EndorsementStatus.WrongSubjectConfiguration;
        if (endorsement.revokedAt != 0) return EndorsementStatus.Revoked;
        if (endorsement.supersededBy != bytes32(0)) return EndorsementStatus.Superseded;
        if (block.timestamp < endorsement.validFrom) return EndorsementStatus.NotStarted;
        if (block.timestamp >= endorsement.validUntil) return EndorsementStatus.Expired;

        Lineage storage issuer = _lineages[endorsement.issuerLineageId];
        if (
            issuer.currentConfigurationId != endorsement.issuerConfigurationId
                || !_configurationLive(_configurations[endorsement.issuerConfigurationId])
        ) return EndorsementStatus.IssuerConfigurationRotated;
        Lineage storage subject = _lineages[endorsement.subjectLineageId];
        if (
            subject.currentConfigurationId != endorsement.subjectConfigurationId
                || !_configurationLive(_configurations[endorsement.subjectConfigurationId])
        ) return EndorsementStatus.SubjectConfigurationRotated;
        return EndorsementStatus.Active;
    }

    function activeReferralSpend(bytes32 issuerLineageId, bytes32 scopeHash)
        external
        view
        returns (uint256 spent, uint256 unused)
    {
        spent = _activeReferralSpend(issuerLineageId, scopeHash, bytes32(0));
        unused = REFERRAL_BUDGET - spent;
    }

    function referralClaimKeys(bytes32 issuerLineageId, bytes32 scopeHash) external view returns (bytes32[] memory) {
        return _referralClaimKeys[_issuerScope(issuerLineageId, scopeHash)];
    }

    function _activateConfiguration(
        bytes32 lineageId,
        IInstanceRegistry.Instance memory record,
        address controller,
        address authority,
        bytes32 familyId,
        bytes32 methodId,
        bytes32 scopeHash,
        bytes32 identityDomain,
        bytes32 sourceLineagePolicyHash
    ) internal returns (bytes32 configurationId) {
        Lineage storage lineage = _lineages[lineageId];
        uint64 version = lineage.currentVersion + 1;
        configurationId = keccak256(
            abi.encode(
                CONFIGURATION_DOMAIN,
                lineageId,
                version,
                record.program,
                record.snapshot,
                record.verifier,
                record.registryOrAccumulator,
                record.paramsHash,
                controller,
                authority,
                familyId,
                methodId,
                scopeHash,
                identityDomain,
                sourceLineagePolicyHash
            )
        );
        _configurations[configurationId] = Configuration({
            lineageId: lineageId,
            version: version,
            programId: record.program,
            snapshot: record.snapshot,
            verifier: record.verifier,
            registryOrAccumulator: record.registryOrAccumulator,
            paramsHash: record.paramsHash,
            controller: controller,
            authority: authority,
            familyId: familyId,
            methodId: methodId,
            scopeHash: scopeHash,
            identityDomain: identityDomain,
            sourceLineagePolicyHash: sourceLineagePolicyHash,
            activatedAt: uint48(block.timestamp)
        });
        lineage.currentVersion = version;
        lineage.currentConfigurationId = configurationId;
        emit ConfigurationActivated(
            lineageId,
            configurationId,
            version,
            record.program,
            record.snapshot,
            record.verifier,
            record.registryOrAccumulator,
            record.paramsHash,
            controller,
            authority,
            familyId,
            methodId,
            scopeHash,
            identityDomain,
            sourceLineagePolicyHash
        );
    }

    function _liveIdentity(bytes32 instanceId)
        internal
        view
        returns (IInstanceRegistry.Instance memory record, address controller, address authority)
    {
        if (!instanceRegistry.isRegistered(instanceId)) revert UnknownInstance(instanceId);
        record = instanceRegistry.getInstance(instanceId);
        controller = instanceRegistry.paramsAuthority(instanceId);
        if (controller == address(0)) revert MissingController(instanceId);
        authority = _controllerAuthority(controller);
    }

    function _controllerAuthority(address controller) internal view returns (address authority) {
        (bool ok, bytes memory returned) = controller.staticcall(abi.encodeWithSignature("owner()"));
        if (ok && returned.length == 32) authority = abi.decode(returned, (address));
        if (authority == address(0)) authority = controller;
    }

    function _configurationLive(Configuration storage config) internal view returns (bool) {
        if (config.lineageId == bytes32(0)) return false;
        Lineage storage lineage = _lineages[config.lineageId];
        if (!lineage.exists || !instanceRegistry.isRegistered(lineage.instanceId)) return false;
        IInstanceRegistry.Instance memory record = instanceRegistry.getInstance(lineage.instanceId);
        address controller = instanceRegistry.paramsAuthority(lineage.instanceId);
        return record.program == config.programId && record.snapshot == config.snapshot
            && record.verifier == config.verifier && record.registryOrAccumulator == config.registryOrAccumulator
            && record.paramsHash == config.paramsHash && controller == config.controller
            && _controllerAuthority(controller) == config.authority;
    }

    function _activeReferralSpend(bytes32 issuerLineageId, bytes32 scopeHash, bytes32 excluded)
        internal
        view
        returns (uint256 spent)
    {
        bytes32[] storage claims = _referralClaimKeys[_issuerScope(issuerLineageId, scopeHash)];
        for (uint256 i = 0; i < claims.length; ++i) {
            bytes32 id = claimHead[claims[i]];
            if (id == excluded) continue;
            Endorsement storage endorsement = _endorsements[id];
            if (
                endorsement.kind == EndorsementKind.Referral
                    && endorsementStatus(id, scopeHash, endorsement.subjectConfigurationId) == EndorsementStatus.Active
            ) spent += endorsement.weight;
        }
    }

    /// @dev Enforce the referral budget over the new claim's complete remaining lifetime, not only
    ///      at issuance time. Otherwise several future-dated claims could each see zero current
    ///      spend and later become active together above the normalized 1e18 mass ceiling.
    function _maxReferralSpendOverValidity(
        bytes32 issuerLineageId,
        bytes32 scopeHash,
        bytes32 excluded,
        uint48 newValidFrom,
        uint48 newValidUntil,
        uint256 newWeight
    ) internal view returns (uint256 maximum) {
        bytes32[] storage claims = _referralClaimKeys[_issuerScope(issuerLineageId, scopeHash)];
        uint48 horizonStart = newValidFrom > block.timestamp ? newValidFrom : uint48(block.timestamp);
        uint48[] memory starts = new uint48[](claims.length + 1);
        uint48[] memory ends = new uint48[](claims.length + 1);
        uint256[] memory weights = new uint256[](claims.length + 1);
        starts[0] = horizonStart;
        ends[0] = newValidUntil;
        weights[0] = newWeight;
        uint256 included = 1;
        bytes32 currentIssuerConfigurationId = _lineages[issuerLineageId].currentConfigurationId;

        for (uint256 i = 0; i < claims.length; ++i) {
            bytes32 id = claimHead[claims[i]];
            if (id == excluded) continue;
            Endorsement storage endorsement = _endorsements[id];
            Lineage storage subject = _lineages[endorsement.subjectLineageId];
            if (
                endorsement.kind != EndorsementKind.Referral || endorsement.revokedAt != 0
                    || endorsement.supersededBy != bytes32(0)
                    || endorsement.issuerConfigurationId != currentIssuerConfigurationId
                    || subject.currentConfigurationId != endorsement.subjectConfigurationId
                    || endorsement.validUntil <= horizonStart || endorsement.validFrom >= newValidUntil
            ) continue;
            starts[included] = endorsement.validFrom > horizonStart ? endorsement.validFrom : horizonStart;
            ends[included] = endorsement.validUntil < newValidUntil ? endorsement.validUntil : newValidUntil;
            weights[included] = endorsement.weight;
            ++included;
        }

        // The active sum changes only at interval starts and ends. A maximum therefore occurs at
        // one of these (clipped) starts; MAX_REFERRAL_SUBJECTS keeps this memory-only scan bounded.
        for (uint256 i = 0; i < included; ++i) {
            uint256 spend;
            for (uint256 j = 0; j < included; ++j) {
                if (starts[j] <= starts[i] && starts[i] < ends[j]) spend += weights[j];
            }
            if (spend > maximum) maximum = spend;
        }
    }

    function _issuerScope(bytes32 issuerLineageId, bytes32 scopeHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(issuerLineageId, scopeHash));
    }

    function _claimKey(bytes32 issuerLineageId, bytes32 subjectLineageId, bytes32 scopeHash, EndorsementKind kind)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(issuerLineageId, subjectLineageId, scopeHash, kind));
    }

    function _requireLineage(bytes32 lineageId) internal view returns (Lineage storage lineage) {
        lineage = _lineages[lineageId];
        if (!lineage.exists) revert UnknownLineage(lineageId);
    }

    function _validateIdentityFields(bytes32 familyId, bytes32 methodId, bytes32 scopeHash, bytes32 identityDomain)
        internal
        pure
    {
        if (familyId == bytes32(0) || methodId == bytes32(0) || scopeHash == bytes32(0) || identityDomain == bytes32(0))
        {
            revert InvalidIdentityField();
        }
    }

    function _validateMetadata(string calldata displayName, string calldata metadataURI) internal pure {
        uint256 displayLength = bytes(displayName).length;
        if (displayLength == 0 || displayLength > MAX_DISPLAY_NAME_BYTES) {
            revert InvalidTextLength(displayLength, MAX_DISPLAY_NAME_BYTES);
        }
        uint256 uriLength = bytes(metadataURI).length;
        if (uriLength > MAX_URI_BYTES) revert InvalidTextLength(uriLength, MAX_URI_BYTES);
    }
}
