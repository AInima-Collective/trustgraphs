// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Test} from "forge-std/Test.sol";
import {Common} from "../../script/Common.s.sol";

/// Reads its context from the real environment, exactly as a deploy run does. Used only by the
/// sequential environment tests: `vm.setEnv` is process-wide and Forge runs a contract's tests in
/// parallel, so tests that toggle a shared variable race each other.
contract EnvHarness is Common {
    function startAndStop() external {
        _startBroadcast();
        vm.stopBroadcast();
    }

    function requireDeliberateEpochFloor(uint64 epochFloor) external view {
        _requireDeliberateEpochFloor(epochFloor, "Harness");
    }
}

/// Drives every environment-derived input directly, so tests stay independent of each other.
contract CommonHarness is Common {
    uint256 private _expectedChain;
    bool private _allowTestnetEpochFloor;

    function setContext(uint256 privateKey, uint256 expectedChainId) external {
        _privateKey = privateKey;
        _expectedChain = expectedChainId;
    }

    function setAllowTestnetEpochFloor(bool allow) external {
        _allowTestnetEpochFloor = allow;
    }

    function startAndStop() external {
        _startBroadcast();
        vm.stopBroadcast();
    }

    function requireDeliberateEpochFloor(uint64 epochFloor) external view {
        _requireDeliberateEpochFloor(epochFloor, "Harness");
    }

    function _expectedChainId() internal view override returns (uint256) {
        return _expectedChain;
    }

    function _allowsTestnetEpochFloor() internal view override returns (bool) {
        return _allowTestnetEpochFloor;
    }
}

contract CommonScriptTest is Test {
    uint256 private constant SAFE_TEST_KEY = 0xA11CE;
    uint256 private constant ANVIL_DEFAULT_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    bytes private constant LOW_FLOOR_REVERT = bytes(
        "Harness: epochFloor too low for a non-dev chain (>= ~1 day of blocks, or ALLOW_TESTNET_EPOCH_FLOOR=true on a testnet)"
    );

    function testBroadcastRequiresExplicitFundedKey() public {
        CommonHarness harness = new CommonHarness();
        harness.setContext(0, block.chainid);
        vm.expectRevert(Common.MissingFundedKey.selector);
        harness.startAndStop();
    }

    function testBroadcastRequiresExplicitExpectedChainId() public {
        CommonHarness harness = new CommonHarness();
        harness.setContext(SAFE_TEST_KEY, 0);
        vm.expectRevert(Common.MissingExpectedChainId.selector);
        harness.startAndStop();
    }

    function testBroadcastRejectsWrongChain() public {
        CommonHarness harness = new CommonHarness();
        harness.setContext(SAFE_TEST_KEY, 11155111);
        vm.expectRevert(abi.encodeWithSelector(Common.UnexpectedChainId.selector, uint256(11155111), block.chainid));
        harness.startAndStop();
    }

    function testPublicChainRejectsKnownAnvilDefaultKey() public {
        vm.chainId(11155111);
        CommonHarness harness = new CommonHarness();
        harness.setContext(ANVIL_DEFAULT_KEY, 11155111);
        vm.expectRevert(Common.AnvilDefaultKeyOnPublicChain.selector);
        harness.startAndStop();
    }

    function testExplicitMatchingContextCanStartBroadcast() public {
        CommonHarness harness = new CommonHarness();
        harness.setContext(SAFE_TEST_KEY, block.chainid);
        harness.startAndStop();
    }

    /// The one test that reads the key and chain from the real environment. It is the only test
    /// that sets those variables and it does so sequentially, so it cannot race.
    function testBroadcastContextIsReadFromTheDeployEnvironment() public {
        vm.setEnv("FUNDED_KEY", vm.toString(SAFE_TEST_KEY));
        vm.setEnv("EXPECTED_CHAIN_ID", vm.toString(block.chainid));
        new EnvHarness().startAndStop();

        // An explicit zero is a missing chain, not a fallback to CHAIN_ID.
        vm.setEnv("EXPECTED_CHAIN_ID", "0");
        vm.setEnv("CHAIN_ID", "0");
        EnvHarness noChain = new EnvHarness();
        vm.expectRevert(Common.MissingExpectedChainId.selector);
        noChain.startAndStop();

        vm.setEnv("FUNDED_KEY", "0");
        EnvHarness noKey = new EnvHarness();
        vm.expectRevert(Common.MissingFundedKey.selector);
        noKey.startAndStop();
    }

    function testDevChainAcceptsAnyEpochFloor() public {
        CommonHarness harness = new CommonHarness();
        harness.requireDeliberateEpochFloor(1);
    }

    function testPublicChainRequiresDeliberateEpochFloorByDefault() public {
        vm.chainId(11155111);
        CommonHarness harness = new CommonHarness();
        harness.requireDeliberateEpochFloor(7200);
        vm.expectRevert(LOW_FLOOR_REVERT);
        harness.requireDeliberateEpochFloor(7199);
    }

    function testTestnetCanOptIntoLowEpochFloor() public {
        vm.chainId(11155111);
        CommonHarness harness = new CommonHarness();
        harness.setAllowTestnetEpochFloor(true);
        harness.requireDeliberateEpochFloor(1);
    }

    function testMainnetNeverAcceptsLowEpochFloor() public {
        vm.chainId(1);
        CommonHarness harness = new CommonHarness();
        harness.setAllowTestnetEpochFloor(true);
        harness.requireDeliberateEpochFloor(7200);
        vm.expectRevert(LOW_FLOOR_REVERT);
        harness.requireDeliberateEpochFloor(7199);
    }

    /// The one test that reads the opt-in from the real environment, sequentially, as above.
    function testOptInIsReadFromTheDeployEnvironment() public {
        vm.chainId(11155111);
        EnvHarness harness = new EnvHarness();
        vm.setEnv("ALLOW_TESTNET_EPOCH_FLOOR", "true");
        harness.requireDeliberateEpochFloor(1);
        vm.setEnv("ALLOW_TESTNET_EPOCH_FLOOR", "false");
        vm.expectRevert(LOW_FLOOR_REVERT);
        harness.requireDeliberateEpochFloor(1);
    }
}
