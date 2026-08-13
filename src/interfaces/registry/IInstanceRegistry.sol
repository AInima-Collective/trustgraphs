// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IInstanceRegistry
/// @notice On-chain directory of trustgraphs deployments (MULTI_PROGRAM_PLATFORM §4): one per chain,
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

    /// @notice The least-privilege authority allowed to update only one row's params hash.
    event ParamsAuthorityUpdated(
        bytes32 indexed instanceId, address indexed oldAuthority, address indexed newAuthority
    );

    /// @notice One instance's parameter commitment changed without repointing any contract.
    event InstanceParamsHashUpdated(bytes32 indexed instanceId, bytes32 oldParamsHash, bytes32 newParamsHash);

    /// @notice Thrown when registering an instance id that already exists.
    error InstanceAlreadyExists(bytes32 instanceId);

    /// @notice Thrown when the caller holds neither `REGISTRAR_ROLE` nor `OPERATOR_ROLE`.
    error NotRegistrar(address caller);

    /// @notice Thrown when updating (or reading) an instance id that was never registered.
    error InstanceNotFound(bytes32 instanceId);

    /// @notice A typed parameter authority must be a real contract/account.
    error InvalidParamsAuthority(address authority);

    /// @notice The caller is not the authority registered for this instance.
    error NotParamsAuthority(bytes32 instanceId, address caller, address expected);

    /// @notice A restricted update must actually change the commitment and may not set zero.
    error InvalidParamsHash(bytes32 paramsHash);

    /// @notice Register a new instance. Open to `REGISTRAR_ROLE` or `OPERATOR_ROLE`; reverts if
    ///         the id already exists.
    /// @dev Declared here so `TrustgraphsFactory` (a registrar) can register through the interface.
    function register(bytes32 instanceId, Instance calldata record) external;

    /// @notice Register a row and its per-instance parameter authority atomically.
    function registerWithParamsAuthority(bytes32 instanceId, Instance calldata record, address paramsAuthority_)
        external;

    /// @notice Replace an existing instance's record. `OPERATOR_ROLE` ONLY — deliberately a
    ///         different role from `register`, so a factory can append rows but can never rewrite
    ///         one. This is the whole of a compromised factory's blast radius on the directory.
    function update(bytes32 instanceId, Instance calldata record) external;

    /// @notice Associate a controller with a legacy row. `OPERATOR_ROLE` only.
    function setParamsAuthority(bytes32 instanceId, address paramsAuthority_) external;

    /// @notice Change only this row's `paramsHash`; callable only by its registered authority.
    function updateParamsHash(bytes32 instanceId, bytes32 paramsHash) external;

    /// @notice Read an instance's contract set. Reverts if unknown.
    function getInstance(bytes32 instanceId) external view returns (Instance memory);

    /// @notice Whether an instance id has been registered.
    function isRegistered(bytes32 instanceId) external view returns (bool);

    /// @notice The least-privilege params authority for an instance, or zero for a legacy row.
    function paramsAuthority(bytes32 instanceId) external view returns (address);

    /// @notice Number of registered instances.
    function instanceCount() external view returns (uint256);

    /// @notice The instance id at an enumeration index.
    function instanceIdAt(uint256 index) external view returns (bytes32);

    /// @notice All registered instance ids.
    function getInstanceIds() external view returns (bytes32[] memory);
}
