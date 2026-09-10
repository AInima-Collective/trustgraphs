// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {console2} from "forge-std/console2.sol";

import {Common} from "script/Common.s.sol";

/// @title HandoffAccessControl
/// @notice Moves every named AccessControl role from the deployer to a long-lived admin in one
///         broadcast, then proves it: grant, renounce, and a post-condition that the deployer
///         holds nothing it was asked to give up.
///
/// @dev Two deploy scripts leave the deployer holding roles it must not keep: `DeployProvingVault`
///      makes the deployer both admin and fee setter because it has to price the fee schedule in
///      the same run, and `DeployGovernedTrustgraphsFactory` makes the deployer the
///      `SubnetworkRegistry` admin because the governed weighted and compose wrappers, deployed
///      later in the same plan, grant themselves `REGISTRAR_ROLE` on it with the deployer's key.
///      Both are correct while the plan is running and wrong the moment it stops. This is the
///      last step of a public-chain plan, once per contract, signed by the deployer.
///
///      The order inside the broadcast matters. Grants go first, while the deployer still holds
///      `DEFAULT_ADMIN_ROLE`; renounces follow, admin last. Reversed, the contract would have no
///      admin at all and the roles could never be granted again. The post-conditions run after
///      the broadcast against chain state, so a printed command that did not land cannot pass.
contract HandoffAccessControl is Common {
    error ZeroAdmin();
    error AdminIsDeployer(address deployer);
    error NoRolesNamed();
    error DeployerLacksRole(bytes32 role, address deployer);
    error DeployerCannotGrant(address target, address deployer);
    error HandoffIncomplete(bytes32 role, address target);

    bytes32 internal constant DEFAULT_ADMIN_ROLE = bytes32(0);

    /// @notice Hand the named roles on `targetAddr` from the deployer to `adminAddr`.
    /// @param targetAddr The AccessControl contract.
    /// @param adminAddr The account that keeps the roles: a Safe, a timelock, never the deployer.
    /// @param roleNames Comma-separated role names, e.g. `DEFAULT_ADMIN_ROLE,FEE_SETTER_ROLE`.
    ///        `DEFAULT_ADMIN_ROLE` is OpenZeppelin's zero hash; every other name is hashed with
    ///        keccak256, the way the contracts themselves derive it.
    function run(string calldata targetAddr, string calldata adminAddr, string calldata roleNames) public {
        IAccessControl target = IAccessControl(vm.parseAddress(targetAddr));
        address admin = vm.parseAddress(adminAddr);
        address deployer = vm.addr(_privateKey);
        if (admin == address(0)) revert ZeroAdmin();
        if (admin == deployer) revert AdminIsDeployer(deployer);
        require(address(target).code.length != 0, "HandoffAccessControl: target has no code");

        bytes32[] memory roles = _parseRoles(roleNames);
        if (!target.hasRole(DEFAULT_ADMIN_ROLE, deployer)) revert DeployerCannotGrant(address(target), deployer);
        for (uint256 i = 0; i < roles.length; i++) {
            if (!target.hasRole(roles[i], deployer)) revert DeployerLacksRole(roles[i], deployer);
        }

        _beginSigning();
        for (uint256 i = 0; i < roles.length; i++) {
            if (!target.hasRole(roles[i], admin)) target.grantRole(roles[i], admin);
        }
        // Admin last: every other renounce may still need it, and once it is gone nothing here can
        // be undone by this key.
        for (uint256 i = 0; i < roles.length; i++) {
            if (roles[i] != DEFAULT_ADMIN_ROLE) target.renounceRole(roles[i], deployer);
        }
        for (uint256 i = 0; i < roles.length; i++) {
            if (roles[i] == DEFAULT_ADMIN_ROLE) target.renounceRole(roles[i], deployer);
        }
        _endSigning();

        for (uint256 i = 0; i < roles.length; i++) {
            if (!target.hasRole(roles[i], admin) || target.hasRole(roles[i], deployer)) {
                revert HandoffIncomplete(roles[i], address(target));
            }
        }
        console2.log("HandoffAccessControl: target", address(target));
        console2.log("HandoffAccessControl: admin now holds every named role", admin);
        console2.log("HandoffAccessControl: deployer holds none of them", deployer);
    }

    /// @dev The broadcast is the one part a unit test cannot drive: `vm.startBroadcast` only records
    ///      transactions there and leaves `msg.sender` alone. Virtual so a harness can prank instead.
    function _beginSigning() internal virtual {
        _startBroadcast();
    }

    function _endSigning() internal virtual {
        vm.stopBroadcast();
    }

    function _parseRoles(string calldata roleNames) internal pure returns (bytes32[] memory roles) {
        string[] memory names = vm.split(roleNames, ",");
        if (names.length == 0) revert NoRolesNamed();
        roles = new bytes32[](names.length);
        for (uint256 i = 0; i < names.length; i++) {
            require(bytes(names[i]).length != 0, "HandoffAccessControl: empty role name");
            roles[i] = keccak256(bytes(names[i])) == keccak256("DEFAULT_ADMIN_ROLE")
                ? DEFAULT_ADMIN_ROLE
                : keccak256(bytes(names[i]));
        }
    }
}
