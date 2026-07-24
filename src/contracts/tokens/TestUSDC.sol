// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSDC
/// @notice Dev-only mock stablecoin for the contributions funding pool: 6 decimals like real USDC
///         so pool amounts and fee math rehearse at production scale. Open mint — anyone may print
///         test funds. NEVER deploy to a network where value matters; production rounds use a real
///         pool token.
contract TestUSDC is ERC20 {
    constructor() ERC20("Test USDC", "tUSDC") {}

    /// @notice USDC-compatible 6 decimals.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Open mint (dev convenience: seed scripts and testers fund themselves).
    /// @param to The recipient of the minted tokens.
    /// @param amount The amount to mint (6-decimal base units).
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
