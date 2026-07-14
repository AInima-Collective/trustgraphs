// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IInstanceRegistry
/// @notice On-chain directory of TrustGraph deployments (MULTI_PROGRAM_PLATFORM §4): one per chain,
///         mapping an instance id to its contract set so any frontend/indexer discovers deployments
///         on-chain instead of via `deployment_summary.json`.
interface IInstanceRegistry {
    /// @notice One deployment's contract set. `program` is a label (e.g. keccak256("trust-graph"));
    ///         `registryOrAccumulator` is the lane-2 `AnchorRegistry` or lane-1 `AttestationAccumulator`.
    struct Instance {
        bytes32 program;
        address snapshot;
        address verifier;
        address registryOrAccumulator;
        bytes32 paramsHash;
    }

    /// @notice A new instance was registered.
    event InstanceRegistered(
        bytes32 indexed instanceId,
        bytes32 indexed program,
        address snapshot,
        address verifier,
        address registryOrAccumulator,
        bytes32 paramsHash
    );

    /// @notice An existing instance's record was replaced.
    event InstanceUpdated(
        bytes32 indexed instanceId,
        bytes32 indexed program,
        address snapshot,
        address verifier,
        address registryOrAccumulator,
        bytes32 paramsHash
    );

    /// @notice Thrown when registering an instance id that already exists.
    error InstanceAlreadyExists(bytes32 instanceId);

    /// @notice Thrown when updating (or reading) an instance id that was never registered.
    error InstanceNotFound(bytes32 instanceId);

    /// @notice Read an instance's contract set. Reverts if unknown.
    function getInstance(bytes32 instanceId) external view returns (Instance memory);

    /// @notice Whether an instance id has been registered.
    function isRegistered(bytes32 instanceId) external view returns (bool);

    /// @notice Number of registered instances.
    function instanceCount() external view returns (uint256);

    /// @notice The instance id at an enumeration index.
    function instanceIdAt(uint256 index) external view returns (bytes32);

    /// @notice All registered instance ids.
    function getInstanceIds() external view returns (bytes32[] memory);
}
