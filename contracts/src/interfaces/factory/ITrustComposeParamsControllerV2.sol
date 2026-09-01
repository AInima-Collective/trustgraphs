// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {TrustComposeParamsCodecV2} from "src/params/TrustComposeParamsCodecV2.sol";

/// @title ITrustComposeParamsControllerV2
/// @notice Recoverable timelocked control plane for one trust-compose V2 source policy.
interface ITrustComposeParamsControllerV2 {
    enum ProposalStatus {
        None,
        Pending,
        Activated,
        Cancelled
    }

    struct PendingPolicy {
        uint64 version;
        uint48 readyAt;
        bytes32 proposalId;
        bytes32 sourcePolicyRoot;
        uint8 sourceCount;
        bytes32 manifestSha256;
        bytes32 adapterSetHash;
        bytes32 metadataDigest;
        bytes32 paramsHash;
    }

    struct VersionCommitment {
        bytes32 paramsHash;
        bytes32 sourcePolicyRoot;
        uint8 sourceCount;
        bytes32 manifestSha256;
        bytes32 adapterSetHash;
        bytes32 metadataDigest;
        uint48 proposedAt;
        uint48 activatedAt;
        uint48 cancelledAt;
        ProposalStatus status;
    }

    event InitialPolicyPublished(
        bytes32 indexed instanceId,
        uint64 indexed version,
        bytes32 indexed paramsHash,
        bytes32 adapterSetHash,
        bytes32 metadataDigest,
        TrustComposeParamsCodecV2.Params params
    );

    /// @dev Exact manifest/adapters remain recoverable from this event's transaction input.
    event PolicyProposed(
        bytes32 indexed instanceId,
        uint64 indexed version,
        bytes32 indexed proposalId,
        bytes32 sourcePolicyRoot,
        uint8 sourceCount,
        bytes32 manifestSha256,
        bytes32 adapterSetHash,
        bytes32 metadataDigest,
        bytes32 paramsHash,
        uint48 readyAt
    );

    event PolicyActivated(
        bytes32 indexed instanceId,
        uint64 indexed version,
        bytes32 indexed paramsHash,
        bytes32 previousParamsHash,
        bytes32 proposalId,
        bytes32 adapterSetHash,
        bytes32 metadataDigest,
        TrustComposeParamsCodecV2.Params params
    );

    event PolicyProposalCancelled(bytes32 indexed instanceId, uint64 indexed version, bytes32 indexed proposalId);

    function getCurrentParams() external view returns (TrustComposeParamsCodecV2.Params memory);
    function getPendingPolicy() external view returns (PendingPolicy memory);
    function versionCommitment(uint64 version) external view returns (VersionCommitment memory);
}
