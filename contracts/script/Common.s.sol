// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @dev Common script for all deployment scripts
contract Common is Script {
    error MissingFundedKey();
    error MissingExpectedChainId();
    error UnexpectedChainId(uint256 expected, uint256 actual);
    error AnvilDefaultKeyOnPublicChain();

    uint256 internal constant ANVIL_DEFAULT_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    // Scripts never supply a deployer fallback. The caller must opt in to the
    // exact key and chain for every broadcast-capable invocation.
    uint256 internal _privateKey = vm.envOr("FUNDED_KEY", uint256(0));

    function _startBroadcast() internal {
        if (_privateKey == 0) revert MissingFundedKey();

        uint256 expectedChainId = vm.envOr("EXPECTED_CHAIN_ID", vm.envOr("CHAIN_ID", uint256(0)));
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
}
