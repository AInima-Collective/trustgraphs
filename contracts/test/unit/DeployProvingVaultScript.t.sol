// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";

import {DeployProvingVault} from "script/DeployProvingVault.s.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IEthUsdFeed} from "interfaces/vault/IEthUsdFeed.sol";
import {ProvingVault} from "src/vault/ProvingVault.sol";
import {TestUSDC} from "src/tokens/TestUSDC.sol";
import {MockEthUsdFeed} from "test/mocks/MockEthUsdFeed.sol";

contract DeployProvingVaultHarness is DeployProvingVault {
    function configureCreationFeeSchedule(ProvingVault vault) external {
        _configureCreationFeeSchedule(vault);
    }
}

contract DeployProvingVaultScriptTest is Test {
    ProvingVault internal vault;
    DeployProvingVaultHarness internal deployer;

    function setUp() public {
        deployer = new DeployProvingVaultHarness();
        MockEthUsdFeed feed = new MockEthUsdFeed();
        TestUSDC usdc = new TestUSDC();
        vault = new ProvingVault(
            IInstanceRegistry(address(this)),
            usdc,
            IEthUsdFeed(address(feed)),
            1 days,
            100e8,
            100_000e8,
            address(deployer),
            address(this)
        );
    }

    function test_DeploymentPricesEveryGovernedCreationProgram() public {
        deployer.configureCreationFeeSchedule(vault);

        bytes32 trustGraph = keccak256("trust-graph");
        bytes32 weighted = keccak256("trust-graph-weighted");
        bytes32 compose = keccak256("trust-compose");

        assertEq(vault.bandOf(trustGraph, 0, 0), 1);
        assertEq(vault.bandOf(weighted, 0, 0), 1);
        assertEq(vault.bandOf(compose, 0, 0), 3);

        assertEq(vault.feePerRootUsd(trustGraph, 1), 5e8);
        assertEq(vault.feePerRootUsd(trustGraph, 2), 10e8);
        assertEq(vault.feePerRootUsd(trustGraph, 3), 15e8);
        assertEq(vault.feePerRootUsd(weighted, 1), 5e8);
        assertEq(vault.feePerRootUsd(weighted, 2), 10e8);
        assertEq(vault.feePerRootUsd(weighted, 3), 15e8);
        assertEq(vault.feePerRootUsd(compose, 3), 15e8);
    }
}
