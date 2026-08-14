// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {WeightedPriorParamsCodec} from "contracts/params/WeightedPriorParamsCodec.sol";

/// @title WeightedPriorValidator
/// @notice Constitutional validation for weighted parameters and canonical TGWP manifests.
/// @dev The manifest is accepted in compact calldata and never copied into persistent storage.
library WeightedPriorValidator {
    uint256 internal constant PRECISION_SCALE = 1e18;
    uint32 internal constant PARAMS_VERSION = 1;
    uint16 internal constant MANIFEST_VERSION = 1;
    uint32 internal constant MAX_PRIOR_ENTRIES = 2048;
    uint32 internal constant MAX_ITERATIONS = 40;
    uint32 internal constant WEIGHT_FIELD_INDEX = 1;
    uint256 internal constant HEADER_LENGTH = 18;
    uint256 internal constant ENTRY_LENGTH = 28;
    bytes4 internal constant MANIFEST_MAGIC = 0x54475750; // "TGWP"

    struct Commitment {
        bytes32 priorRoot;
        uint32 priorCount;
        bytes32 manifestSha256;
        uint64 chainId;
    }

    error DerivedFieldNotZero();
    error InvalidParamsVersion(uint32 version);
    error InvalidDamping(uint64 dampingFp);
    error InvalidTolerance(uint64 toleranceFp);
    error InvalidIterations(uint32 maxIterations);
    error InvalidWeightBounds(uint64 minWeight, uint64 maxWeight);
    error InvalidWeightFieldIndex(uint32 weightFieldIndex);
    error InvalidParamsChain(uint64 chainId);
    error InvalidManifestLength(uint256 actual, uint256 expected);
    error InvalidManifestMagic(bytes4 magic);
    error InvalidManifestVersion(uint16 version);
    error InvalidManifestChain(uint64 actual, uint64 expected);
    error InvalidPriorCount(uint32 count);
    error InvalidPriorAccount(uint32 index, address account);
    error PriorAccountsNotAscending(uint32 index, address previous, address account);
    error InvalidPriorWeight(uint32 index);
    error InvalidPriorWeightSum(uint256 sum);
    error PriorCommitmentMismatch();
    error IdentityFieldChanged();

    /// @notice Validate user-selected creation fields before the factory derives identity and prior fields.
    function validateCreation(WeightedPriorParamsCodec.Params memory p) internal pure {
        if (
            p.priorRoot != bytes32(0) || p.priorCount != 0 || p.manifestSha256 != bytes32(0)
                || p.schemaUid != bytes32(0) || p.accumulator != address(0) || p.chainId != 0
        ) revert DerivedFieldNotZero();
        _validateTuning(p);
    }

    /// @notice Validate a complete tuple and prove its commitment came from `manifest`.
    function validateFinal(WeightedPriorParamsCodec.Params memory p, bytes calldata manifest) internal pure {
        validateComputationalEnvelope(p);
        Commitment memory commitment = validateManifest(manifest, p.chainId);
        if (
            p.priorRoot != commitment.priorRoot || p.priorCount != commitment.priorCount
                || p.manifestSha256 != commitment.manifestSha256
        ) revert PriorCommitmentMismatch();
    }

    /// @notice Prove all non-prior fields remain bound to the instance's initial constitution.
    function validateRotation(
        WeightedPriorParamsCodec.Params memory next,
        WeightedPriorParamsCodec.Params memory initial
    ) internal pure {
        validateComputationalEnvelope(next);
        if (
            next.version != initial.version || next.dampingFp != initial.dampingFp
                || next.toleranceFp != initial.toleranceFp || next.maxIterations != initial.maxIterations
                || next.minWeight != initial.minWeight || next.maxWeight != initial.maxWeight
                || next.schemaUid != initial.schemaUid || next.weightFieldIndex != initial.weightFieldIndex
                || next.accumulator != initial.accumulator || next.chainId != initial.chainId
        ) revert IdentityFieldChanged();
    }

    function validateComputationalEnvelope(WeightedPriorParamsCodec.Params memory p) internal pure {
        _validateTuning(p);
        if (p.priorCount == 0 || p.priorCount > MAX_PRIOR_ENTRIES) revert InvalidPriorCount(p.priorCount);
        if (p.chainId == 0) revert InvalidParamsChain(p.chainId);
    }

    function _validateTuning(WeightedPriorParamsCodec.Params memory p) private pure {
        if (p.version != PARAMS_VERSION) revert InvalidParamsVersion(p.version);
        if (p.dampingFp == 0 || p.dampingFp >= PRECISION_SCALE) revert InvalidDamping(p.dampingFp);
        if (p.toleranceFp > PRECISION_SCALE) revert InvalidTolerance(p.toleranceFp);
        if (p.maxIterations == 0 || p.maxIterations > MAX_ITERATIONS) {
            revert InvalidIterations(p.maxIterations);
        }
        if (p.maxWeight == 0 || p.minWeight > p.maxWeight) {
            revert InvalidWeightBounds(p.minWeight, p.maxWeight);
        }
        if (p.weightFieldIndex != WEIGHT_FIELD_INDEX) {
            revert InvalidWeightFieldIndex(p.weightFieldIndex);
        }
    }

    /// @notice Parse and fully validate one canonical TGWP V1 manifest.
    /// @return commitment The Merkle root, row count, exact-byte SHA-256, and manifest chain ID.
    function validateManifest(bytes calldata manifest, uint64 expectedChain)
        internal
        pure
        returns (Commitment memory commitment)
    {
        uint256 length = manifest.length;
        if (length < HEADER_LENGTH) revert InvalidManifestLength(length, HEADER_LENGTH);

        bytes4 magic;
        uint16 manifestVersion;
        uint64 manifestChain;
        uint32 count;
        assembly ("memory-safe") {
            let header := calldataload(manifest.offset)
            // Fixed-size bytes values are left-aligned on the Solidity stack.
            magic := header
            manifestVersion := and(shr(208, header), 0xffff)
            manifestChain := and(shr(144, header), 0xffffffffffffffff)
            count := and(shr(112, header), 0xffffffff)
        }

        if (magic != MANIFEST_MAGIC) revert InvalidManifestMagic(magic);
        if (manifestVersion != MANIFEST_VERSION) revert InvalidManifestVersion(manifestVersion);
        if (manifestChain != expectedChain) revert InvalidManifestChain(manifestChain, expectedChain);
        if (count == 0 || count > MAX_PRIOR_ENTRIES) revert InvalidPriorCount(count);

        uint256 expectedLength = HEADER_LENGTH + uint256(count) * ENTRY_LENGTH;
        if (length != expectedLength) revert InvalidManifestLength(length, expectedLength);

        bytes32[] memory level = new bytes32[](count);
        uint256 sum;
        address previous;
        for (uint32 i; i < count; ++i) {
            uint256 offset = HEADER_LENGTH + uint256(i) * ENTRY_LENGTH;
            address account;
            uint64 weight;
            assembly ("memory-safe") {
                account := shr(96, calldataload(add(manifest.offset, offset)))
                weight := shr(192, calldataload(add(add(manifest.offset, offset), 20)))
            }
            if (account == address(0)) revert InvalidPriorAccount(i, account);
            if (account <= previous) revert PriorAccountsNotAscending(i, previous, account);
            if (weight == 0) revert InvalidPriorWeight(i);

            previous = account;
            sum += weight;
            level[i] = keccak256(abi.encode(account, uint256(weight)));
        }
        if (sum != PRECISION_SCALE) revert InvalidPriorWeightSum(sum);

        commitment = Commitment({
            priorRoot: _merkleRoot(level, count),
            priorCount: count,
            manifestSha256: sha256(manifest),
            chainId: manifestChain
        });
    }

    /// @notice Constructor-only equivalent of `validateManifest` for bytes already ABI-decoded to memory.
    function validateManifestMemory(bytes memory manifest, uint64 expectedChain)
        internal
        pure
        returns (Commitment memory commitment)
    {
        uint256 length = manifest.length;
        if (length < HEADER_LENGTH) revert InvalidManifestLength(length, HEADER_LENGTH);

        bytes4 magic;
        uint16 manifestVersion;
        uint64 manifestChain;
        uint32 count;
        assembly ("memory-safe") {
            let header := mload(add(manifest, 32))
            magic := header
            manifestVersion := and(shr(208, header), 0xffff)
            manifestChain := and(shr(144, header), 0xffffffffffffffff)
            count := and(shr(112, header), 0xffffffff)
        }

        if (magic != MANIFEST_MAGIC) revert InvalidManifestMagic(magic);
        if (manifestVersion != MANIFEST_VERSION) revert InvalidManifestVersion(manifestVersion);
        if (manifestChain != expectedChain) revert InvalidManifestChain(manifestChain, expectedChain);
        if (count == 0 || count > MAX_PRIOR_ENTRIES) revert InvalidPriorCount(count);

        uint256 expectedLength = HEADER_LENGTH + uint256(count) * ENTRY_LENGTH;
        if (length != expectedLength) revert InvalidManifestLength(length, expectedLength);

        bytes32[] memory level = new bytes32[](count);
        uint256 sum;
        address previous;
        for (uint32 i; i < count; ++i) {
            uint256 offset = HEADER_LENGTH + uint256(i) * ENTRY_LENGTH;
            address account;
            uint64 weight;
            assembly ("memory-safe") {
                account := shr(96, mload(add(add(manifest, 32), offset)))
                weight := shr(192, mload(add(add(add(manifest, 32), offset), 20)))
            }
            if (account == address(0)) revert InvalidPriorAccount(i, account);
            if (account <= previous) revert PriorAccountsNotAscending(i, previous, account);
            if (weight == 0) revert InvalidPriorWeight(i);

            previous = account;
            sum += weight;
            level[i] = keccak256(abi.encode(account, uint256(weight)));
        }
        if (sum != PRECISION_SCALE) revert InvalidPriorWeightSum(sum);

        commitment = Commitment({
            priorRoot: _merkleRoot(level, count),
            priorCount: count,
            manifestSha256: sha256(manifest),
            chainId: manifestChain
        });
    }

    function _merkleRoot(bytes32[] memory level, uint256 width) private pure returns (bytes32) {
        while (width > 1) {
            uint256 nextWidth;
            for (uint256 i; i < width; i += 2) {
                if (i + 1 == width) {
                    level[nextWidth++] = level[i];
                } else {
                    bytes32 left = level[i];
                    bytes32 right = level[i + 1];
                    level[nextWidth++] = left < right
                        ? keccak256(abi.encodePacked(left, right))
                        : keccak256(abi.encodePacked(right, left));
                }
            }
            width = nextWidth;
        }
        return level[0];
    }
}
