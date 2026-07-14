// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

/// @title InstanceRegistry
/// @notice One per chain (MULTI_PROGRAM_PLATFORM §4): a registrable, enumerable directory mapping an
///         `instanceId` (e.g. keccak256 of a label) to its deployment record — program label, snapshot,
///         verifier, lane registry/accumulator, and paramsHash. Frontends and indexers discover the full
///         contract set on-chain instead of reading `deployment_summary.json`.
/// @dev Single operational-timelock role (`OPERATOR_ROLE`) gates register/update — mirroring
///      MerkleSnapshot's operational tier, but one role suffices since there is no truth-defining knob
///      here (this is a directory, not a verifier). DEFAULT_ADMIN_ROLE administers OPERATOR_ROLE.
contract InstanceRegistry is IInstanceRegistry, AccessControl {
    /// @notice May register/update instances; held by the operational timelock.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice The deployment record per instance id (zeroed struct until registered).
    mapping(bytes32 instanceId => Instance) internal _instances;

    /// @notice Whether an instance id has been registered (distinguishes an empty record from absence).
    mapping(bytes32 instanceId => bool) public isRegistered;

    /// @notice Every registered instance id, in registration order (enumeration source).
    bytes32[] internal _instanceIds;

    /// @param admin Authority over OPERATOR_ROLE (the operational timelock); also holds OPERATOR_ROLE.
    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
    }

    /// @notice Register a new instance. Reverts if the id already exists.
    function register(bytes32 instanceId, Instance calldata record) external onlyRole(OPERATOR_ROLE) {
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
