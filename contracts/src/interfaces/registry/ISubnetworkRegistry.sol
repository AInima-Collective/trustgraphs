// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title ISubnetworkRegistry
/// @notice Consent record for parent-child relationships between registered trustgraphs instances.
/// @dev The registry records organizational relationships only. It deliberately makes no claim
///      about the power instruments (Safe modules, snapshot roles, or recovery proposers) that a
///      parent may currently hold over a child.
interface ISubnetworkRegistry {
    event ParentClaimed(
        bytes32 indexed childInstanceId, bytes32 indexed parentInstanceId, address indexed childAuthority
    );
    event ChildAccepted(
        bytes32 indexed childInstanceId, bytes32 indexed parentInstanceId, address indexed parentAuthority
    );
    event ParentClaimCancelled(
        bytes32 indexed childInstanceId, bytes32 indexed parentInstanceId, address indexed cancelledBy
    );
    event SubnetworkRegistered(
        bytes32 indexed childInstanceId, bytes32 indexed parentInstanceId, address indexed registrar
    );
    event SubnetworkReleased(
        bytes32 indexed childInstanceId, bytes32 indexed parentInstanceId, address indexed parentAuthority
    );

    error ZeroAddress();
    error UnknownInstance(bytes32 instanceId);
    error MissingAuthority(bytes32 instanceId);
    error Unauthorized(bytes32 instanceId, address caller, address expectedAuthority);
    error NotClaimParticipant(bytes32 childInstanceId, address caller, address childAuthority, address parentAuthority);
    error SelfParent(bytes32 instanceId);
    error ParentAlreadySet(bytes32 childInstanceId, bytes32 parentInstanceId);
    error PendingClaimExists(bytes32 childInstanceId, bytes32 parentInstanceId);
    error NoPendingClaim(bytes32 childInstanceId);
    error NoParent(bytes32 childInstanceId);
    error CycleDetected(bytes32 childInstanceId, bytes32 parentInstanceId);
    error MaximumDepthExceeded(bytes32 childInstanceId, bytes32 parentInstanceId, uint256 maximumDepth);

    /// @notice Nominate `parentInstanceId` as a parent. Only the child's current authority may call.
    function claimParent(bytes32 childInstanceId, bytes32 parentInstanceId) external;

    /// @notice Accept a pending child nomination. Only the proposed parent's current authority may call.
    function acceptChild(bytes32 childInstanceId) external;

    /// @notice Withdraw a pending nomination. Either side's current authority may call.
    function cancelParentClaim(bytes32 childInstanceId) external;

    /// @notice Atomically record an accepted link. Restricted to trusted creation factories.
    function registerSubnetwork(bytes32 childInstanceId, bytes32 parentInstanceId) external;

    /// @notice Dissolve an accepted link. Only the parent's current authority may call.
    function release(bytes32 childInstanceId) external;

    /// @notice Resolve an instance's current authority through its registered params controller.
    function authorityOf(bytes32 instanceId) external view returns (address);

    /// @notice The accepted parent for a child, or zero when it is independent.
    function parentOf(bytes32 childInstanceId) external view returns (bytes32);

    /// @notice The nominated parent awaiting acceptance, or zero when no claim is pending.
    function pendingParentOf(bytes32 childInstanceId) external view returns (bytes32);
}
