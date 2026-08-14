// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {Enum} from "@gnosis.pm/safe-contracts/common/Enum.sol";

/// @title DelayedRecoveryModule
/// @notice A visible, cancellable break-glass route for a module-only governed Safe. The recovery
///         proposer may queue an arbitrary Safe action, but anybody can execute it only after the
///         immutable delay. The Safe itself (therefore member governance) may cancel or rotate the
///         proposer.
/// @dev The module deliberately supports calls and delegatecalls: it is the constitutional recovery
///      route. That power is bounded by a 14-day-or-longer public exit/veto window at construction,
///      not hidden behind a 1-of-1 Safe signature.
contract DelayedRecoveryModule {
    uint48 public constant MIN_DELAY = 14 days;

    GnosisSafe public immutable safe;
    uint48 public immutable delay;
    address public proposer;
    uint256 public nextNonce;

    mapping(bytes32 actionId => uint256 readyAt) public readyAt;

    error ZeroAddress();
    error DelayTooShort(uint48 supplied, uint48 minimum);
    error OnlyProposer(address caller);
    error OnlySafe(address caller);
    error NotAuthorizedToCancel(address caller);
    error UnknownAction(bytes32 actionId);
    error RecoveryDelayNotElapsed(bytes32 actionId, uint256 readyAt);
    error SafeExecutionFailed(bytes32 actionId);

    event RecoveryScheduled(
        bytes32 indexed actionId,
        uint256 indexed nonce,
        address indexed proposer,
        address target,
        uint256 value,
        bytes data,
        Enum.Operation operation,
        uint256 readyAt
    );
    event RecoveryCancelled(bytes32 indexed actionId, address indexed canceller);
    event RecoveryExecuted(bytes32 indexed actionId, address indexed executor);
    event RecoveryProposerUpdated(address indexed previousProposer, address indexed newProposer);

    constructor(address safe_, address proposer_, uint48 delay_) {
        if (safe_ == address(0) || proposer_ == address(0)) revert ZeroAddress();
        if (delay_ < MIN_DELAY) revert DelayTooShort(delay_, MIN_DELAY);
        safe = GnosisSafe(payable(safe_));
        proposer = proposer_;
        delay = delay_;
    }

    /// @notice Queue one exact Safe action. Its nonce prevents cancellation/re-execution ambiguity.
    function schedule(address target, uint256 value, bytes calldata data, Enum.Operation operation)
        external
        returns (bytes32 actionId)
    {
        if (msg.sender != proposer) revert OnlyProposer(msg.sender);
        if (target == address(0)) revert ZeroAddress();

        uint256 nonce = nextNonce++;
        actionId = hashAction(nonce, target, value, data, operation);
        uint256 executableAt = block.timestamp + delay;
        readyAt[actionId] = executableAt;
        emit RecoveryScheduled(actionId, nonce, msg.sender, target, value, data, operation, executableAt);
    }

    /// @notice Execute an exact queued action after its immutable delay. Permissionless so the
    ///         proposer cannot withhold a recovery the public already relied on.
    function execute(uint256 nonce, address target, uint256 value, bytes calldata data, Enum.Operation operation)
        external
    {
        bytes32 actionId = hashAction(nonce, target, value, data, operation);
        uint256 executableAt = readyAt[actionId];
        if (executableAt == 0) revert UnknownAction(actionId);
        if (block.timestamp < executableAt) revert RecoveryDelayNotElapsed(actionId, executableAt);

        delete readyAt[actionId];
        bool success = safe.execTransactionFromModule(target, value, data, operation);
        if (!success) revert SafeExecutionFailed(actionId);
        emit RecoveryExecuted(actionId, msg.sender);
    }

    /// @notice Cancel a queued action. The proposer can withdraw a mistake; the Safe can veto
    ///         through a passed member-governance proposal without trusting the proposer.
    function cancel(bytes32 actionId) external {
        if (msg.sender != proposer && msg.sender != address(safe)) revert NotAuthorizedToCancel(msg.sender);
        if (readyAt[actionId] == 0) revert UnknownAction(actionId);
        delete readyAt[actionId];
        emit RecoveryCancelled(actionId, msg.sender);
    }

    /// @notice Rotate the recovery identity through the Safe's module-only authority graph.
    function setProposer(address newProposer) external {
        if (msg.sender != address(safe)) revert OnlySafe(msg.sender);
        if (newProposer == address(0)) revert ZeroAddress();
        address previous = proposer;
        proposer = newProposer;
        emit RecoveryProposerUpdated(previous, newProposer);
    }

    function hashAction(uint256 nonce, address target, uint256 value, bytes calldata data, Enum.Operation operation)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), nonce, target, value, keccak256(data), operation));
    }
}
