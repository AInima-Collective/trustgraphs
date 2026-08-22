// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {WeightedPriorParamsCodec} from "src/params/WeightedPriorParamsCodec.sol";

/// @title IWeightedPriorParamsController
/// @notice Versioned, recoverable control plane for one weighted-prior instance.
interface IWeightedPriorParamsController {
    struct PendingPrior {
        uint64 version;
        uint48 readyAt;
        bytes32 proposalId;
        bytes32 priorRoot;
        uint32 priorCount;
        bytes32 manifestSha256;
        bytes32 metadataDigest;
        bytes32 paramsHash;
    }

    struct VersionCommitment {
        bytes32 paramsHash;
        bytes32 priorRoot;
        uint32 priorCount;
        bytes32 manifestSha256;
        bytes32 metadataDigest;
        uint48 proposedAt;
        uint48 activatedAt;
    }

    /// @dev The exact V1 manifest is recoverable from this event's transaction input.
    event InitialPriorPublished(
        bytes32 indexed instanceId,
        uint64 indexed version,
        bytes32 indexed paramsHash,
        bytes32 metadataDigest,
        WeightedPriorParamsCodec.Params params
    );

    /// @dev The exact proposed manifest is recoverable from this event's transaction input.
    event PriorProposed(
        bytes32 indexed instanceId,
        uint64 indexed version,
        bytes32 indexed proposalId,
        bytes32 priorRoot,
        uint32 priorCount,
        bytes32 manifestSha256,
        bytes32 metadataDigest,
        bytes32 paramsHash,
        uint48 readyAt
    );

    event PriorActivated(
        bytes32 indexed instanceId,
        uint64 indexed version,
        bytes32 indexed paramsHash,
        bytes32 previousParamsHash,
        bytes32 proposalId,
        bytes32 metadataDigest,
        WeightedPriorParamsCodec.Params params
    );

    event PriorProposalCancelled(bytes32 indexed instanceId, uint64 indexed version, bytes32 indexed proposalId);

    function instanceId() external view returns (bytes32);
    function snapshot() external view returns (address);
    function version() external view returns (uint64);
    function currentParamsHash() external view returns (bytes32);
    function activationDelay() external view returns (uint48);
    function getCurrentParams() external view returns (WeightedPriorParamsCodec.Params memory);
    function getPendingPrior() external view returns (PendingPrior memory);
    function versionCommitment(uint64 version_) external view returns (VersionCommitment memory);

    function proposePrior(bytes calldata manifest, bytes32 metadataDigest)
        external
        returns (uint64 pendingVersion, bytes32 proposalId, uint48 readyAt);
    function cancelPrior() external;
    function activatePrior(uint64 expectedVersion) external returns (bytes32 paramsHash);
}
