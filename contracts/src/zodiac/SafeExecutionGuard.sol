// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Enum} from "@gnosis.pm/safe-contracts/common/Enum.sol";
import {Guard} from "@gnosis.pm/safe-contracts/base/GuardManager.sol";

/// @title SafeExecutionGuard
/// @notice Permanently closes a governed Safe's owner-signature execution path after atomic factory
///         setup. Enabled modules remain the only execution routes and must enforce their own vote
///         or recovery delay.
/// @dev Safe guards do not inspect `execTransactionFromModule`; that is intentional here. The
///      factory enables exactly the Merkle governance and delayed-recovery modules before sealing.
///      Once sealed, owner calls cannot remove this guard, enable another module, delegatecall,
///      batch, transfer funds, or reach any external target through `execTransaction`.
contract SafeExecutionGuard is Guard {
    address public immutable safe;
    address public immutable bootstrapper;
    bool public isSealed;

    error ZeroAddress();
    error OnlySafe(address caller);
    error OnlyBootstrapper(address caller);
    error AlreadySealed();
    error OwnerExecutionLocked(address submitter);

    event GuardSealed(address indexed safe, address indexed bootstrapper);

    constructor(address safe_, address bootstrapper_) {
        if (safe_ == address(0) || bootstrapper_ == address(0)) revert ZeroAddress();
        safe = safe_;
        bootstrapper = bootstrapper_;
    }

    /// @notice Irreversibly end the factory-only setup window.
    function seal() external {
        if (msg.sender != bootstrapper) revert OnlyBootstrapper(msg.sender);
        if (isSealed) revert AlreadySealed();
        isSealed = true;
        emit GuardSealed(safe, bootstrapper);
    }

    /// @inheritdoc Guard
    function checkTransaction(
        address,
        uint256,
        bytes memory,
        Enum.Operation,
        uint256,
        uint256,
        uint256,
        address,
        address payable,
        bytes memory,
        address msgSender
    ) external view override {
        if (msg.sender != safe) revert OnlySafe(msg.sender);
        if (!isSealed && msgSender == bootstrapper) return;
        revert OwnerExecutionLocked(msgSender);
    }

    /// @inheritdoc Guard
    function checkAfterExecution(bytes32, bool) external view override {
        if (msg.sender != safe) revert OnlySafe(msg.sender);
    }
}
