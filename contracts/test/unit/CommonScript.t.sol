// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {Common} from "../../script/Common.s.sol";

contract CommonHarness is Common {
    function startAndStop() external {
        _startBroadcast();
        vm.stopBroadcast();
    }
}

contract CommonScriptTest is Test {
    uint256 private constant SAFE_TEST_KEY = 0xA11CE;
    uint256 private constant ANVIL_DEFAULT_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function testBroadcastRequiresExplicitFundedKey() public {
        vm.setEnv("FUNDED_KEY", "0");
        vm.setEnv("EXPECTED_CHAIN_ID", vm.toString(block.chainid));

        CommonHarness harness = new CommonHarness();
        vm.expectRevert(Common.MissingFundedKey.selector);
        harness.startAndStop();
    }

    function testBroadcastRequiresExplicitExpectedChainId() public {
        vm.setEnv("FUNDED_KEY", vm.toString(SAFE_TEST_KEY));
        vm.setEnv("EXPECTED_CHAIN_ID", "0");
        vm.setEnv("CHAIN_ID", "0");

        CommonHarness harness = new CommonHarness();
        vm.expectRevert(Common.MissingExpectedChainId.selector);
        harness.startAndStop();
    }

    function testBroadcastRejectsWrongChain() public {
        vm.setEnv("FUNDED_KEY", vm.toString(SAFE_TEST_KEY));
        vm.setEnv("EXPECTED_CHAIN_ID", "11155111");

        CommonHarness harness = new CommonHarness();
        vm.expectRevert(abi.encodeWithSelector(Common.UnexpectedChainId.selector, uint256(11155111), block.chainid));
        harness.startAndStop();
    }

    function testPublicChainRejectsKnownAnvilDefaultKey() public {
        vm.chainId(11155111);
        vm.setEnv("FUNDED_KEY", vm.toString(ANVIL_DEFAULT_KEY));
        vm.setEnv("EXPECTED_CHAIN_ID", "11155111");

        CommonHarness harness = new CommonHarness();
        vm.expectRevert(Common.AnvilDefaultKeyOnPublicChain.selector);
        harness.startAndStop();
    }

    function testExplicitMatchingContextCanStartBroadcast() public {
        vm.setEnv("FUNDED_KEY", vm.toString(SAFE_TEST_KEY));
        vm.setEnv("EXPECTED_CHAIN_ID", vm.toString(block.chainid));

        CommonHarness harness = new CommonHarness();
        harness.startAndStop();
    }
}
