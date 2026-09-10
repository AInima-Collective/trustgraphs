// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @dev Common script for all deployment scripts
contract Common is Script {
    error MissingFundedKey();
    error MissingExpectedChainId();
    error UnexpectedChainId(uint256 expected, uint256 actual);
    error AnvilDefaultKeyOnPublicChain();

    uint256 internal constant ANVIL_DEFAULT_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    /// @dev The least epoch floor that could be deliberate on a real chain: roughly a day of blocks.
    ///      Mainnet's intended value is ~30 days (216000).
    uint64 internal constant DELIBERATE_EPOCH_FLOOR = 7200;

    // Scripts never supply a deployer fallback. The caller must opt in to the
    // exact key and chain for every broadcast-capable invocation.
    uint256 internal _privateKey = vm.envOr("FUNDED_KEY", uint256(0));

    function _startBroadcast() internal {
        if (_privateKey == 0) revert MissingFundedKey();

        uint256 expectedChainId = _expectedChainId();
        if (expectedChainId == 0) revert MissingExpectedChainId();
        if (block.chainid != expectedChainId) {
            revert UnexpectedChainId(expectedChainId, block.chainid);
        }
        if (block.chainid != 31337 && _privateKey == ANVIL_DEFAULT_KEY) {
            revert AnvilDefaultKeyOnPublicChain();
        }

        address deployer = vm.addr(_privateKey);
        console2.log("Deployment chain id", block.chainid);
        console2.log("Deployment account", deployer);
        console2.log("Deployment balance", deployer.balance);
        vm.startBroadcast(_privateKey);
    }

    /// @dev The floor is IMMUTABLE and it is what bounds hosted proving cost per instance, so a dev
    ///      default must not reach a real chain. `contracts/deploy/env.ts` hardcodes 1 block for local
    ///      anvil and the stage defaults to `development`, which makes "unset env + real RPC" a
    ///      one-typo path to a permissionless factory whose floor is one block. A public testnet may
    ///      opt in to a lower floor for fast-cadence showcase factories, explicitly, per deploy, with
    ///      `ALLOW_TESTNET_EPOCH_FLOOR=true`. Ethereum mainnet never can.
    function _requireDeliberateEpochFloor(uint64 epochFloor, string memory script) internal view {
        if (block.chainid == 31337 || epochFloor >= DELIBERATE_EPOCH_FLOOR) return;
        bool testnetOptIn = block.chainid != 1 && _allowsTestnetEpochFloor();
        require(
            testnetOptIn,
            string.concat(
                script,
                ": epochFloor too low for a non-dev chain (>= ~1 day of blocks, or ALLOW_TESTNET_EPOCH_FLOOR=true on a testnet)"
            )
        );
    }

    /// @dev The chain the caller says it means. Virtual so a test harness can drive it without
    ///      `vm.setEnv`, which is process-wide and races parallel tests.
    function _expectedChainId() internal view virtual returns (uint256) {
        return vm.envOr("EXPECTED_CHAIN_ID", vm.envOr("CHAIN_ID", uint256(0)));
    }

    /// @dev The opt-in is read from the environment of the deploy run. Virtual for the same reason.
    function _allowsTestnetEpochFloor() internal view virtual returns (bool) {
        return vm.envOr("ALLOW_TESTNET_EPOCH_FLOOR", false);
    }
}
