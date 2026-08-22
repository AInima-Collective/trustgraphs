// SPDX-License-Identifier: MIT
// Compatible with OpenZeppelin Contracts ^5.0.0
pragma solidity ^0.8.27;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC1363} from "@openzeppelin/contracts/token/ERC20/extensions/ERC1363.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

contract TEST is ERC20, AccessControl, ERC20Burnable, ERC20Pausable, ERC1363, ERC20Permit, ERC20Votes {
    bytes32 public constant TOKEN_BRIDGE_ROLE = keccak256("TOKEN_BRIDGE_ROLE");

    error Unauthorized();

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    constructor(address defaultAdmin, address tokenBridge, address pauser, address minter)
        ERC20("TEST", "TEST")
        ERC20Permit("MyToken")
    {
        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(TOKEN_BRIDGE_ROLE, tokenBridge);
        _grantRole(PAUSER_ROLE, pauser);
        _grantRole(MINTER_ROLE, minter);
    }

    function pause() public onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() public onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function mint(address to, uint256 amount) public onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    // The following functions are overrides required by Solidity.

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Pausable, ERC20Votes) {
        super._update(from, to, value);
    }

    function supportsInterface(bytes4 interfaceId) public view override(AccessControl, ERC1363) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
