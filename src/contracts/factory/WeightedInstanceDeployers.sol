// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {WeightedPriorParamsController} from "contracts/factory/WeightedPriorParamsController.sol";
import {WeightedPriorParamsCodec} from "contracts/params/WeightedPriorParamsCodec.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

/// @title WeightedPriorParamsControllerDeployer
/// @notice Keeps the weighted controller's creation code outside the factory's EIP-170 budget.
/// @dev Every authority is explicit; this permissionless helper retains no role or ownership.
contract WeightedPriorParamsControllerDeployer {
    function deploy(
        bytes32 instanceId,
        address snapshot,
        IInstanceRegistry registry,
        WeightedPriorParamsCodec.Params calldata initialParams,
        bytes calldata initialManifest,
        bytes32 initialMetadataDigest,
        address owner,
        uint48 activationDelay
    ) external returns (WeightedPriorParamsController) {
        return new WeightedPriorParamsController(
            instanceId,
            snapshot,
            registry,
            initialParams,
            initialManifest,
            initialMetadataDigest,
            owner,
            msg.sender,
            activationDelay
        );
    }
}
