// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Safe} from "@safe-global/safe-smart-account/Safe.sol";
import {Enum} from "@safe-global/safe-smart-account/libraries/Enum.sol";

import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

/// @title ParentAuthorityModule
/// @notice A contestable parent-admin route into a child network's module-only Safe.
/// @dev Parent authority is resolved dynamically from `InstanceRegistry` for every privileged
///      action. With a zero delay it is an immediate admin; with a nonzero delay it is a public,
///      child-cancellable guardian. The child's own governance can disable this Safe module.
contract ParentAuthorityModule {
    Safe public immutable safe;
    IInstanceRegistry public immutable INSTANCE_REGISTRY;
    bytes32 public immutable childInstanceId;
    bytes32 public immutable parentInstanceId;
    uint48 public immutable executionDelay;

    uint256 public nextNonce;
    bool public renounced;
    mapping(bytes32 actionId => uint256 executableAt) public readyAt;

    error ZeroAddress();
    error ZeroInstanceId();
    error SameInstance(bytes32 instanceId);
    error UnknownInstance(bytes32 instanceId);
    error MissingAuthority(bytes32 instanceId);
    error ChildAuthorityMismatch(bytes32 childInstanceId, address resolvedAuthority, address safe);
    error OnlyParentAuthority(address caller, address expectedAuthority);
    error NotAuthorizedToCancel(address caller, address parentAuthority, address childSafe);
    error ParentAuthorityRenounced();
    error InstantExecutionDisabled(uint48 executionDelay);
    error SchedulingDisabled();
    error UnknownAction(bytes32 actionId);
    error ExecutionDelayNotElapsed(bytes32 actionId, uint256 executableAt);
    error SafeExecutionFailed(bytes32 actionId);

    event ParentActionScheduled(
        bytes32 indexed childInstanceId,
        bytes32 indexed parentInstanceId,
        bytes32 indexed actionId,
        uint256 nonce,
        address parentAuthority,
        address target,
        uint256 value,
        bytes data,
        Enum.Operation operation,
        uint256 executableAt
    );
    event ParentActionCancelled(
        bytes32 indexed childInstanceId, bytes32 indexed parentInstanceId, bytes32 indexed actionId, address cancelledBy
    );
    event ParentActionExecuted(
        bytes32 indexed childInstanceId,
        bytes32 indexed parentInstanceId,
        bytes32 indexed actionId,
        uint256 nonce,
        address executor,
        address target,
        uint256 value,
        bytes data,
        Enum.Operation operation
    );
    event ParentPowerRenounced(
        bytes32 indexed childInstanceId, bytes32 indexed parentInstanceId, address indexed parentAuthority
    );

    constructor(
        address safe_,
        IInstanceRegistry instanceRegistry_,
        bytes32 childInstanceId_,
        bytes32 parentInstanceId_,
        uint48 executionDelay_
    ) {
        if (safe_ == address(0) || address(instanceRegistry_) == address(0)) {
            revert ZeroAddress();
        }
        if (childInstanceId_ == bytes32(0) || parentInstanceId_ == bytes32(0)) revert ZeroInstanceId();
        if (childInstanceId_ == parentInstanceId_) revert SameInstance(childInstanceId_);

        INSTANCE_REGISTRY = instanceRegistry_;
        childInstanceId = childInstanceId_;
        parentInstanceId = parentInstanceId_;
        executionDelay = executionDelay_;
        safe = Safe(payable(safe_));

        address childAuthority = _authorityOf(childInstanceId_);
        if (childAuthority != safe_) revert ChildAuthorityMismatch(childInstanceId_, childAuthority, safe_);
        _authorityOf(parentInstanceId_);
    }

    /// @notice Execute immediately through the child Safe. Available only when the delay is zero.
    function execute(address target, uint256 value, bytes calldata data, Enum.Operation operation)
        external
        returns (bytes32 actionId)
    {
        if (renounced) revert ParentAuthorityRenounced();
        if (executionDelay != 0) revert InstantExecutionDisabled(executionDelay);
        address authority = _requireParentAuthority();
        if (target == address(0)) revert ZeroAddress();

        uint256 nonce = nextNonce++;
        actionId = hashAction(nonce, target, value, data, operation);
        _execute(actionId, target, value, data, operation);
        emit ParentActionExecuted(
            childInstanceId, parentInstanceId, actionId, nonce, authority, target, value, data, operation
        );
    }

    /// @notice Queue an exact child-Safe action. Available only when the delay is nonzero.
    function schedule(address target, uint256 value, bytes calldata data, Enum.Operation operation)
        external
        returns (bytes32 actionId)
    {
        if (renounced) revert ParentAuthorityRenounced();
        if (executionDelay == 0) revert SchedulingDisabled();
        address authority = _requireParentAuthority();
        if (target == address(0)) revert ZeroAddress();

        uint256 nonce = nextNonce++;
        actionId = hashAction(nonce, target, value, data, operation);
        uint256 executableAt = block.timestamp + executionDelay;
        readyAt[actionId] = executableAt;
        emit ParentActionScheduled(
            childInstanceId, parentInstanceId, actionId, nonce, authority, target, value, data, operation, executableAt
        );
    }

    /// @notice Execute an exact queued action once its public delay has elapsed.
    function executeScheduled(
        uint256 nonce,
        address target,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation
    ) external {
        if (renounced) revert ParentAuthorityRenounced();
        bytes32 actionId = hashAction(nonce, target, value, data, operation);
        uint256 executableAt = readyAt[actionId];
        if (executableAt == 0) revert UnknownAction(actionId);
        if (block.timestamp < executableAt) revert ExecutionDelayNotElapsed(actionId, executableAt);

        delete readyAt[actionId];
        _execute(actionId, target, value, data, operation);
        emit ParentActionExecuted(
            childInstanceId, parentInstanceId, actionId, nonce, msg.sender, target, value, data, operation
        );
    }

    /// @notice Cancel a queued action. The current parent or the child Safe may veto it.
    function cancel(bytes32 actionId) external {
        address authority = _authorityOf(parentInstanceId);
        if (msg.sender != authority && msg.sender != address(safe)) {
            revert NotAuthorizedToCancel(msg.sender, authority, address(safe));
        }
        if (readyAt[actionId] == 0) revert UnknownAction(actionId);
        delete readyAt[actionId];
        emit ParentActionCancelled(childInstanceId, parentInstanceId, actionId, msg.sender);
    }

    /// @notice Permanently surrender this module's parent power. Only the current parent may call.
    function renounce() external {
        if (renounced) revert ParentAuthorityRenounced();
        address authority = _requireParentAuthority();
        renounced = true;
        emit ParentPowerRenounced(childInstanceId, parentInstanceId, authority);
    }

    /// @notice Resolve the parent instance's current authority.
    function parentAuthority() external view returns (address) {
        return _authorityOf(parentInstanceId);
    }

    function hashAction(uint256 nonce, address target, uint256 value, bytes calldata data, Enum.Operation operation)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), nonce, target, value, keccak256(data), operation));
    }

    function _requireParentAuthority() internal view returns (address authority) {
        authority = _authorityOf(parentInstanceId);
        if (msg.sender != authority) revert OnlyParentAuthority(msg.sender, authority);
    }

    function _authorityOf(bytes32 instanceId) internal view returns (address authority) {
        if (!INSTANCE_REGISTRY.isRegistered(instanceId)) revert UnknownInstance(instanceId);
        address controller = INSTANCE_REGISTRY.paramsAuthority(instanceId);
        if (controller == address(0)) revert MissingAuthority(instanceId);

        authority = controller;
        (bool ok, bytes memory returned) = controller.staticcall(abi.encodeWithSignature("owner()"));
        if (ok && returned.length == 32) {
            address owner = abi.decode(returned, (address));
            if (owner != address(0)) authority = owner;
        }
    }

    function _execute(bytes32 actionId, address target, uint256 value, bytes calldata data, Enum.Operation operation)
        internal
    {
        bool success = safe.execTransactionFromModule(target, value, data, operation);
        if (!success) revert SafeExecutionFailed(actionId);
    }
}
