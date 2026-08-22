// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ParamsCodec} from "src/params/ParamsCodec.sol";

/// @title ITrustgraphsParamsController
/// @notice Self-describing, versioned control plane for one trust-graph instance.
interface ITrustgraphsParamsController {
    event ParamsUpdated(
        bytes32 indexed instanceId,
        uint64 indexed version,
        bytes32 indexed paramsHash,
        bytes32 previousParamsHash,
        ParamsCodec.Params params,
        string evidenceURI
    );

    function instanceId() external view returns (bytes32);
    function snapshot() external view returns (address);
    function version() external view returns (uint64);
    function currentParamsHash() external view returns (bytes32);
    function getCurrentParams() external view returns (ParamsCodec.Params memory);

    function updateParams(ParamsCodec.Params calldata next, string calldata evidenceURI)
        external
        returns (uint64 newVersion, bytes32 newHash);
}
