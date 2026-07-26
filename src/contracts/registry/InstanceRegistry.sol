// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

/// @title InstanceRegistry
/// @notice One per chain (MULTI_PROGRAM_PLATFORM §4): a registrable, enumerable directory mapping an
///         `instanceId` (e.g. keccak256 of a label) to its deployment record — program label, snapshot,
///         verifier, lane registry/accumulator, and paramsHash. Frontends and indexers discover the full
///         contract set on-chain instead of reading `deployment_summary.json`.
/// @dev TWO roles, because appending a row and rewriting one are different privileges:
///      `REGISTRAR_ROLE` may only `register`, `OPERATOR_ROLE` (the operational timelock) may also
///      `update`. That split is what lets a permissionless factory hold the append privilege
///      without also holding the power to re-point an existing community's directory entry.
///      `DEFAULT_ADMIN_ROLE` administers both.
contract InstanceRegistry is IInstanceRegistry, AccessControl {
    /// @notice May UPDATE (rewrite) an existing instance record; held by the operational timelock.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice May REGISTER new instances only. Held by `TrustGraphFactory`, so that creating a
    ///         network is permissionless through the factory while rewriting history is not.
    /// @dev    Split out from `OPERATOR_ROLE` because the two are not the same privilege and the
    ///         difference is the factory's entire blast radius. A single role would mean granting
    ///         the factory the power to point any existing instance's directory row at a snapshot
    ///         and verifier of its choosing — which every doc, comment and deploy script here
    ///         claimed it could not do. Holders of `OPERATOR_ROLE` may still register, so an
    ///         existing timelock-driven deployment needs no new grant.
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    /// @notice The deployment record per instance id (zeroed struct until registered).
    mapping(bytes32 instanceId => Instance) internal _instances;

    /// @notice Whether an instance id has been registered (distinguishes an empty record from absence).
    mapping(bytes32 instanceId => bool) public isRegistered;

    /// @notice Every registered instance id, in registration order (enumeration source).
    bytes32[] internal _instanceIds;

    /// @param admin Authority over both roles (the operational timelock); also holds OPERATOR_ROLE.
    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
    }

    /// @notice Register a new instance. Reverts if the id already exists.
    /// @dev Open to `REGISTRAR_ROLE` and to `OPERATOR_ROLE` (a rewriter can obviously also append).
    function register(bytes32 instanceId, Instance calldata record) external {
        if (!hasRole(REGISTRAR_ROLE, msg.sender) && !hasRole(OPERATOR_ROLE, msg.sender)) {
            revert NotRegistrar(msg.sender);
        }
        if (isRegistered[instanceId]) revert InstanceAlreadyExists(instanceId);
        isRegistered[instanceId] = true;
        _instances[instanceId] = record;
        _instanceIds.push(instanceId);
        emit InstanceRegistered(
            instanceId,
            record.program,
            record.snapshot,
            record.verifier,
            record.registryOrAccumulator,
            record.paramsHash
        );
    }

    /// @notice Replace an existing instance's record (e.g. a redeploy or params rotation). Reverts if
    ///         the id was never registered — enumeration stays append-only, no reordering.
    function update(bytes32 instanceId, Instance calldata record) external onlyRole(OPERATOR_ROLE) {
        if (!isRegistered[instanceId]) revert InstanceNotFound(instanceId);
        _instances[instanceId] = record;
        emit InstanceUpdated(
            instanceId,
            record.program,
            record.snapshot,
            record.verifier,
            record.registryOrAccumulator,
            record.paramsHash
        );
    }

    /// @inheritdoc IInstanceRegistry
    function getInstance(bytes32 instanceId) external view returns (Instance memory) {
        if (!isRegistered[instanceId]) revert InstanceNotFound(instanceId);
        return _instances[instanceId];
    }

    /// @inheritdoc IInstanceRegistry
    function instanceCount() external view returns (uint256) {
        return _instanceIds.length;
    }

    /// @inheritdoc IInstanceRegistry
    function instanceIdAt(uint256 index) external view returns (bytes32) {
        return _instanceIds[index];
    }

    /// @inheritdoc IInstanceRegistry
    function getInstanceIds() external view returns (bytes32[] memory) {
        return _instanceIds;
    }
}
