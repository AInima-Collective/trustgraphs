// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title MutualRecognitionParamsCodec
/// @notice Encoder for the frozen `trust-graph-mutual` V1 parameter commitment.
/// @dev The order and widths below are consensus-critical. They mirror
///      `mutual_recognition_core::encode::params_hash` exactly.
library MutualRecognitionParamsCodec {
    uint32 internal constant PARAMS_VERSION = 1;

    struct Params {
        uint32 version;
        uint64 dampingFp;
        uint64 toleranceFp;
        uint32 maxIterations;
        uint64 minWeight;
        uint64 maxWeight;
        bytes32 priorRoot;
        uint32 priorCount;
        bytes32 manifestSha256;
        bytes32 schemaUid;
        uint32 weightFieldIndex;
        address accumulator;
        uint64 chainId;
    }

    /// @notice `keccak256(abi.encode(...13 static fields...))` for mutual params V1.
    function hash(Params memory p) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                p.version,
                p.dampingFp,
                p.toleranceFp,
                p.maxIterations,
                p.minWeight,
                p.maxWeight,
                p.priorRoot,
                p.priorCount,
                p.manifestSha256,
                p.schemaUid,
                p.weightFieldIndex,
                p.accumulator,
                p.chainId
            )
        );
    }
}
