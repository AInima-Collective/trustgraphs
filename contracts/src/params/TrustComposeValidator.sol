// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {TrustComposeParamsCodec} from "src/params/TrustComposeParamsCodec.sol";

/// @title TrustComposeValidator
/// @notice Constitutional validation for V1 composition params and compact `TGCP` source policy.
library TrustComposeValidator {
    uint64 internal constant WEIGHT_SCALE = 1e18;
    uint32 internal constant PARAMS_VERSION = 1;
    uint16 internal constant MANIFEST_VERSION = 1;
    uint8 internal constant MIN_SOURCES = 2;
    uint8 internal constant MAX_SOURCES = 8;
    uint32 internal constant MAX_ENTRIES_PER_SOURCE = 4096;
    uint32 internal constant MAX_AGGREGATE_ENTRIES = 8192;
    uint32 internal constant MAX_UNION_ACCOUNTS = 8192;
    uint32 internal constant MAX_AGGREGATE_BLOB_BYTES = 1_048_576;
    uint64 internal constant MAX_SOURCE_AGE_BLOCKS = 500_000;
    uint256 internal constant HEADER_LENGTH = 15;
    uint256 internal constant RECORD_LENGTH = 133;
    bytes4 internal constant MANIFEST_MAGIC = 0x54474350; // "TGCP"
    bytes32 internal constant PROGRAM_ID = keccak256("trust-compose");
    bytes32 internal constant IDENTITY_DOMAIN = keccak256("eip155-address");
    bytes32 internal constant OUTPUT_KIND = keccak256("allocation");
    bytes32 internal constant OUTPUT_DOMAIN = keccak256("trustgraphs.output.trust-compose-account.v1");

    struct Commitment {
        bytes32 sourcePolicyRoot;
        uint8 sourceCount;
        bytes32 manifestSha256;
        uint64 chainId;
    }

    error InvalidParamsVersion(uint32 version);
    error InvalidProgramId(bytes32 programId);
    error InvalidScope();
    error InvalidIdentityDomain(bytes32 identityDomain);
    error InvalidOutputKind(bytes32 outputKind);
    error InvalidOutputDomain(bytes32 outputDomain);
    error InvalidAdmittedProgram(bytes32 programId);
    error InvalidWeightScale(uint64 weightScale);
    error InvalidOutputPool();
    error InvalidSourceCount(uint8 count);
    error InvalidPolicyCommitment();
    error InvalidBounds();
    error InvalidMaxSourceAge(uint64 maxAgeBlocks);
    error InvalidAccumulator();
    error InvalidChain(uint64 chainId);
    error InvalidManifestLength(uint256 actual, uint256 expected);
    error InvalidManifestMagic(bytes4 magic);
    error InvalidManifestVersion(uint16 version);
    error InvalidManifestChain(uint64 actual, uint64 expected);
    error InvalidSourceId(uint8 index, bytes32 sourceId);
    error SourceIdsNotAscending(uint8 index, bytes32 previous, bytes32 sourceId);
    error InvalidSnapshot(uint8 index, address snapshot);
    error DuplicateSnapshot(uint8 index, address snapshot);
    error InvalidFamilyId(uint8 index);
    error UnadmittedSourceProgram(uint8 index, bytes32 programId);
    error InvalidSourceWeight(uint8 index);
    error InvalidWeightSum(uint256 sum);
    error InvalidSourceAge(uint8 index, uint64 maxAgeBlocks);
    error OptionalSourceUnsupported(uint8 index);
    error PolicyCommitmentMismatch();
    error DerivedFieldNotZero();
    error IdentityFieldChanged();

    /// @notice Validate user-selected creation fields before factory-derived policy/chain fields.
    function validateCreation(TrustComposeParamsCodec.Params memory p) internal pure {
        if (
            p.sourcePolicyRoot != bytes32(0) || p.sourceCount != 0 || p.policyManifestSha256 != bytes32(0)
                || p.accumulator != address(0) || p.chainId != 0
        ) revert DerivedFieldNotZero();
        _validateStatic(p, false);
    }

    function validateFinal(TrustComposeParamsCodec.Params memory p, bytes calldata manifest)
        internal
        pure
        returns (Commitment memory commitment)
    {
        validateComputationalEnvelope(p);
        commitment = validatePolicyManifest(manifest, p.chainId, p.admittedProgramId, p.maxSourceAgeBlocks);
        if (
            commitment.sourcePolicyRoot != p.sourcePolicyRoot || commitment.sourceCount != p.sourceCount
                || commitment.manifestSha256 != p.policyManifestSha256
        ) revert PolicyCommitmentMismatch();
    }

    function validateComputationalEnvelope(TrustComposeParamsCodec.Params memory p) internal pure {
        _validateStatic(p, true);
        if (p.chainId == 0) revert InvalidChain(p.chainId);
    }

    /// @notice Prove every field except the complete source policy remains constitutional.
    function validateRotation(TrustComposeParamsCodec.Params memory next, TrustComposeParamsCodec.Params memory initial)
        internal
        pure
    {
        validateComputationalEnvelope(next);
        if (
            next.version != initial.version || next.programId != initial.programId
                || next.scopeHash != initial.scopeHash || next.identityDomain != initial.identityDomain
                || next.outputKind != initial.outputKind || next.outputDomain != initial.outputDomain
                || next.admittedProgramId != initial.admittedProgramId || next.weightScale != initial.weightScale
                || next.outputPool != initial.outputPool || next.maxSources != initial.maxSources
                || next.maxEntriesPerSource != initial.maxEntriesPerSource
                || next.maxAggregateEntries != initial.maxAggregateEntries
                || next.maxUnionAccounts != initial.maxUnionAccounts
                || next.maxAggregateBlobBytes != initial.maxAggregateBlobBytes
                || next.maxSourceAgeBlocks != initial.maxSourceAgeBlocks || next.accumulator != initial.accumulator
                || next.chainId != initial.chainId
        ) revert IdentityFieldChanged();
    }

    function _validateStatic(TrustComposeParamsCodec.Params memory p, bool requirePolicy) private pure {
        if (p.version != PARAMS_VERSION) revert InvalidParamsVersion(p.version);
        if (p.programId != PROGRAM_ID) revert InvalidProgramId(p.programId);
        if (p.scopeHash == bytes32(0)) revert InvalidScope();
        if (p.identityDomain != IDENTITY_DOMAIN) revert InvalidIdentityDomain(p.identityDomain);
        if (p.outputKind != OUTPUT_KIND) revert InvalidOutputKind(p.outputKind);
        if (p.outputDomain != OUTPUT_DOMAIN) revert InvalidOutputDomain(p.outputDomain);
        if (p.admittedProgramId == bytes32(0) || p.admittedProgramId == PROGRAM_ID) {
            revert InvalidAdmittedProgram(p.admittedProgramId);
        }
        if (p.weightScale != WEIGHT_SCALE) revert InvalidWeightScale(p.weightScale);
        // `sourceCount` can grow on policy rotation while `outputPool` is an immutable identity
        // field. Reserve one unit for every source the instance can ever admit, so neither
        // creation nor a later rotation can deterministically starve a required source merely
        // because the pool is smaller than the source set.
        if (p.outputPool < p.maxSources) revert InvalidOutputPool();
        if (requirePolicy) {
            if (p.sourceCount < MIN_SOURCES || p.sourceCount > MAX_SOURCES || p.sourceCount > p.maxSources) {
                revert InvalidSourceCount(p.sourceCount);
            }
            if (p.sourcePolicyRoot == bytes32(0) || p.policyManifestSha256 == bytes32(0)) {
                revert InvalidPolicyCommitment();
            }
        }
        if (
            p.maxSources < MIN_SOURCES || p.maxSources > MAX_SOURCES || p.maxEntriesPerSource == 0
                || p.maxEntriesPerSource > MAX_ENTRIES_PER_SOURCE || p.maxAggregateEntries == 0
                || p.maxAggregateEntries > MAX_AGGREGATE_ENTRIES || p.maxUnionAccounts == 0
                || p.maxUnionAccounts > MAX_UNION_ACCOUNTS || p.maxAggregateBlobBytes == 0
                || p.maxAggregateBlobBytes > MAX_AGGREGATE_BLOB_BYTES || p.maxEntriesPerSource > p.maxAggregateEntries
                || p.maxUnionAccounts > p.maxAggregateEntries
        ) revert InvalidBounds();
        if (p.maxSourceAgeBlocks == 0 || p.maxSourceAgeBlocks > MAX_SOURCE_AGE_BLOCKS) {
            revert InvalidMaxSourceAge(p.maxSourceAgeBlocks);
        }
        if (requirePolicy && p.accumulator == address(0)) revert InvalidAccumulator();
    }

    /// @notice Constructor equivalent of `validatePolicyManifest` for ABI-decoded memory bytes.
    function validatePolicyManifestMemory(
        bytes memory manifest,
        uint64 expectedChain,
        bytes32 admittedProgramId,
        uint64 maximumAge
    ) internal pure returns (Commitment memory commitment) {
        uint256 length = manifest.length;
        if (length < HEADER_LENGTH) revert InvalidManifestLength(length, HEADER_LENGTH);
        bytes4 magic;
        uint16 version;
        uint64 chainId;
        uint8 count;
        assembly ("memory-safe") {
            let header := mload(add(manifest, 32))
            magic := header
            version := and(shr(208, header), 0xffff)
            chainId := and(shr(144, header), 0xffffffffffffffff)
            count := and(shr(136, header), 0xff)
        }
        if (magic != MANIFEST_MAGIC) revert InvalidManifestMagic(magic);
        if (version != MANIFEST_VERSION) revert InvalidManifestVersion(version);
        if (chainId != expectedChain) revert InvalidManifestChain(chainId, expectedChain);
        if (count < MIN_SOURCES || count > MAX_SOURCES) revert InvalidSourceCount(count);
        uint256 expectedLength = HEADER_LENGTH + uint256(count) * RECORD_LENGTH;
        if (length != expectedLength) revert InvalidManifestLength(length, expectedLength);

        bytes32[] memory level = new bytes32[](count);
        address[] memory snapshots = new address[](count);
        bytes32 previousId;
        uint256 weightSum;
        for (uint8 i; i < count; ++i) {
            uint256 offset = HEADER_LENGTH + uint256(i) * RECORD_LENGTH;
            bytes32 sourceId;
            address snapshot;
            bytes32 familyId;
            bytes32 programId;
            uint64 weight;
            uint64 maxAgeBlocks;
            uint8 required;
            assembly ("memory-safe") {
                sourceId := mload(add(add(manifest, 32), offset))
                snapshot := shr(96, mload(add(add(add(manifest, 32), offset), 32)))
                familyId := mload(add(add(add(manifest, 32), offset), 52))
                programId := mload(add(add(add(manifest, 32), offset), 84))
                weight := shr(192, mload(add(add(add(manifest, 32), offset), 116)))
                maxAgeBlocks := shr(192, mload(add(add(add(manifest, 32), offset), 124)))
                required := shr(248, mload(add(add(add(manifest, 32), offset), 132)))
            }
            if (sourceId == bytes32(0)) revert InvalidSourceId(i, sourceId);
            if (sourceId <= previousId) revert SourceIdsNotAscending(i, previousId, sourceId);
            if (snapshot == address(0)) revert InvalidSnapshot(i, snapshot);
            for (uint8 j; j < i; ++j) {
                if (snapshots[j] == snapshot) revert DuplicateSnapshot(i, snapshot);
            }
            if (familyId == bytes32(0)) revert InvalidFamilyId(i);
            if (programId != admittedProgramId || programId == PROGRAM_ID) {
                revert UnadmittedSourceProgram(i, programId);
            }
            if (weight == 0) revert InvalidSourceWeight(i);
            if (maxAgeBlocks == 0 || maxAgeBlocks > maximumAge) revert InvalidSourceAge(i, maxAgeBlocks);
            if (required != 1) revert OptionalSourceUnsupported(i);
            previousId = sourceId;
            snapshots[i] = snapshot;
            weightSum += weight;
            level[i] = keccak256(abi.encode(sourceId, snapshot, familyId, programId, weight, maxAgeBlocks, required));
        }
        if (weightSum != WEIGHT_SCALE) revert InvalidWeightSum(weightSum);
        commitment = Commitment({
            sourcePolicyRoot: _orderedRoot(level),
            sourceCount: count,
            manifestSha256: sha256(manifest),
            chainId: chainId
        });
    }

    function validatePolicyManifest(
        bytes calldata manifest,
        uint64 expectedChain,
        bytes32 admittedProgramId,
        uint64 maximumAge
    ) internal pure returns (Commitment memory commitment) {
        uint256 length = manifest.length;
        if (length < HEADER_LENGTH) revert InvalidManifestLength(length, HEADER_LENGTH);
        bytes4 magic;
        uint16 version;
        uint64 chainId;
        uint8 count;
        assembly ("memory-safe") {
            let header := calldataload(manifest.offset)
            magic := header
            version := and(shr(208, header), 0xffff)
            chainId := and(shr(144, header), 0xffffffffffffffff)
            count := and(shr(136, header), 0xff)
        }
        if (magic != MANIFEST_MAGIC) revert InvalidManifestMagic(magic);
        if (version != MANIFEST_VERSION) revert InvalidManifestVersion(version);
        if (chainId != expectedChain) revert InvalidManifestChain(chainId, expectedChain);
        if (count < MIN_SOURCES || count > MAX_SOURCES) revert InvalidSourceCount(count);
        uint256 expectedLength = HEADER_LENGTH + uint256(count) * RECORD_LENGTH;
        if (length != expectedLength) revert InvalidManifestLength(length, expectedLength);

        bytes32[] memory level = new bytes32[](count);
        address[] memory snapshots = new address[](count);
        bytes32 previousId;
        uint256 weightSum;
        for (uint8 i; i < count; ++i) {
            uint256 offset = HEADER_LENGTH + uint256(i) * RECORD_LENGTH;
            bytes32 sourceId;
            address snapshot;
            bytes32 familyId;
            bytes32 programId;
            uint64 weight;
            uint64 maxAgeBlocks;
            uint8 required;
            assembly ("memory-safe") {
                sourceId := calldataload(add(manifest.offset, offset))
                snapshot := shr(96, calldataload(add(add(manifest.offset, offset), 32)))
                familyId := calldataload(add(add(manifest.offset, offset), 52))
                programId := calldataload(add(add(manifest.offset, offset), 84))
                weight := shr(192, calldataload(add(add(manifest.offset, offset), 116)))
                maxAgeBlocks := shr(192, calldataload(add(add(manifest.offset, offset), 124)))
                required := shr(248, calldataload(add(add(manifest.offset, offset), 132)))
            }
            if (sourceId == bytes32(0)) revert InvalidSourceId(i, sourceId);
            if (sourceId <= previousId) revert SourceIdsNotAscending(i, previousId, sourceId);
            if (snapshot == address(0)) revert InvalidSnapshot(i, snapshot);
            for (uint8 j; j < i; ++j) {
                if (snapshots[j] == snapshot) revert DuplicateSnapshot(i, snapshot);
            }
            if (familyId == bytes32(0)) revert InvalidFamilyId(i);
            if (programId != admittedProgramId || programId == PROGRAM_ID) {
                revert UnadmittedSourceProgram(i, programId);
            }
            if (weight == 0) revert InvalidSourceWeight(i);
            if (maxAgeBlocks == 0 || maxAgeBlocks > maximumAge) revert InvalidSourceAge(i, maxAgeBlocks);
            if (required != 1) revert OptionalSourceUnsupported(i);

            previousId = sourceId;
            snapshots[i] = snapshot;
            weightSum += weight;
            level[i] = keccak256(abi.encode(sourceId, snapshot, familyId, programId, weight, maxAgeBlocks, required));
        }
        if (weightSum != WEIGHT_SCALE) revert InvalidWeightSum(weightSum);
        commitment = Commitment({
            sourcePolicyRoot: _orderedRoot(level),
            sourceCount: count,
            manifestSha256: sha256(manifest),
            chainId: chainId
        });
    }

    function _orderedRoot(bytes32[] memory level) private pure returns (bytes32) {
        uint256 width = level.length;
        while (width > 1) {
            uint256 nextWidth;
            for (uint256 i; i < width; i += 2) {
                if (i + 1 == width) {
                    level[nextWidth++] = level[i];
                } else {
                    bytes32 left = level[i];
                    bytes32 right = level[i + 1];
                    level[nextWidth++] =
                        left < right ? keccak256(bytes.concat(left, right)) : keccak256(bytes.concat(right, left));
                }
            }
            width = nextWidth;
        }
        return level[0];
    }
}
