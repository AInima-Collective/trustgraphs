// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {DeployEAS} from "../../script/DeployEAS.s.sol";

contract DeployEASScriptTest is Test {
    function testPublicChainRequiresExplicitCanonicalAddresses() public {
        vm.chainId(11155111);
        DeployEAS script = new DeployEAS();

        vm.expectRevert(abi.encodeWithSelector(DeployEAS.ExplicitEASAddressesRequired.selector, uint256(11155111)));
        script.run();
    }

    function testExplicitCanonicalAddressesMustHaveCode() public {
        vm.chainId(11155111);
        DeployEAS script = new DeployEAS();
        address noCode = address(0x1111);

        vm.expectRevert(abi.encodeWithSelector(DeployEAS.ExternalContractHasNoCode.selector, noCode));
        script.run(vm.toString(noCode), vm.toString(address(0x2222)));
    }
}
