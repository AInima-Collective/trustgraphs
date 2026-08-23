// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title RoleSeparatedTimelockController
/// @notice An OpenZeppelin timelock whose proposer and emergency canceller are independent.
/// @dev OpenZeppelin's constructor grants every proposer `CANCELLER_ROLE`. This constructor keeps
///      the standard controller implementation and self-admin model but assigns the two duties
///      independently from the first block. No temporary external admin or post-deploy role
///      mutation is needed.
contract RoleSeparatedTimelockController is TimelockController {
    error ZeroProposer();
    error ZeroCanceller();
    error ProposerIsCanceller(address account);

    constructor(uint256 minDelay, address proposer, address canceller, address[] memory executors)
        TimelockController(minDelay, new address[](0), executors, address(0))
    {
        if (proposer == address(0)) revert ZeroProposer();
        if (canceller == address(0)) revert ZeroCanceller();
        if (proposer == canceller) revert ProposerIsCanceller(proposer);
        _grantRole(PROPOSER_ROLE, proposer);
        _grantRole(CANCELLER_ROLE, canceller);
    }
}
