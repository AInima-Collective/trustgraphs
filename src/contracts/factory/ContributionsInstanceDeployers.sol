// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ContributionsParamsController} from "contracts/factory/ContributionsParamsController.sol";
import {ContributionsParamsCodec} from "contracts/params/ContributionsParamsCodec.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

/// @title ContributionsParamsControllerDeployer
/// @notice Holds the typed contributions controller's creation code outside `ContributionsFactory`
///         for EIP-170 — the same trick as `TrustgraphsParamsControllerDeployer`
///         (`InstanceDeployers.sol`).
/// @dev Safe for the same reason as the others: every authority is an explicit constructor
///      argument, so this permissionless helper never owns what it deploys. `msg.sender` (the
///      factory) becomes the controller's `initialPublisher`, which is what lets the factory defer
///      `publishInitialVersion()` until after its own discovery events — the ordering that keeps
///      indexers from meeting a controller event before the instance row exists.
contract ContributionsParamsControllerDeployer {
    function deploy(
        bytes32 instanceId,
        address snapshot,
        address eas,
        IInstanceRegistry registry,
        ContributionsParamsCodec.Params calldata initialParams,
        address owner
    ) external returns (ContributionsParamsController) {
        return new ContributionsParamsController(instanceId, snapshot, eas, registry, initialParams, owner, msg.sender);
    }
}
