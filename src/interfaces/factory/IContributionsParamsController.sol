// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ContributionsParamsCodec} from "contracts/params/ContributionsParamsCodec.sol";

/// @title IContributionsParamsController
/// @notice Self-describing, versioned control plane for one contributions instance.
interface IContributionsParamsController {
    event ContributionsParamsUpdated(
        bytes32 indexed instanceId,
        uint64 indexed version,
        bytes32 indexed paramsHash,
        bytes32 previousParamsHash,
        ContributionsParamsCodec.Params params,
        string evidenceURI
    );

    function instanceId() external view returns (bytes32);
    function snapshot() external view returns (address);
    function eas() external view returns (address);
    function version() external view returns (uint64);
    function currentParamsHash() external view returns (bytes32);
    function getContributionsParams() external view returns (ContributionsParamsCodec.Params memory);

    function updateParams(ContributionsParamsCodec.Params calldata next, string calldata evidenceURI)
        external
        returns (uint64 newVersion, bytes32 newHash);
}
