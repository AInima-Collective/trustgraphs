// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";

import {ProvingVault} from "src/vault/ProvingVault.sol";
import {TestUSDC} from "src/tokens/TestUSDC.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IEthUsdFeed} from "interfaces/vault/IEthUsdFeed.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MockEthUsdFeed} from "test/mocks/MockEthUsdFeed.sol";

import {Common} from "script/Common.s.sol";

/// @title DeployProvingVault
/// @notice Deploys the per-instance proving tank a community tops up so somebody keeps proving its
///         scores, and prices a root so the very first claim can actually pay.
///
/// @dev Runs BEFORE `DeployFactory`, because the factory takes the vault as a constructor argument
///      and that argument is what makes `createInstance` payable. Deploying the two in the other
///      order gives you a factory that permanently reverts on any prepay — the address is
///      immutable.
///
///      **Dev stubs, and exactly where they stop.** On a local chain there is no ETH/USD feed and
///      no USDC, so this deploys a `MockEthUsdFeed` and a `TestUSDC` unless `ETH_USD_FEED` /
///      `USDC` name real ones. That is the same seam `DeployMockGateway` uses for the SP1 gateway,
///      and it is the only stubbed part: the vault itself, its payout arithmetic, the fee bands,
///      the cadence guard and the front-run split are all production code either way. On any chain
///      but 31337 both addresses are REQUIRED — a mock feed on a real chain is a licence to
///      withdraw a tank at whatever price the deployer feels like.
///
///      The fee schedule is set here rather than left to a follow-up call because an unpriced band
///      is not a smaller demo, it is a silent one: roots land, claims run, and every payout is
///      zero. Band 0 is reserved for "we do not price this" and refuses to be set.
contract DeployProvingVault is Common {
    using stdJson for string;

    string public root = vm.projectRoot();

    /// @notice Deploy the vault.
    /// @param instanceRegistryAddr The chain's `InstanceRegistry`. Accounts bind to a snapshot by
    ///        resolving it exactly once, at first deposit.
    /// @return provingVault The deployed vault.
    function run(string calldata instanceRegistryAddr) public returns (address provingVault) {
        address deployer = vm.addr(_privateKey);
        address instanceRegistry = vm.parseAddress(instanceRegistryAddr);
        require(instanceRegistry != address(0), "DeployProvingVault: instanceRegistry is zero");

        address feed = vm.envOr("ETH_USD_FEED", address(0));
        address usdc = vm.envOr("USDC", address(0));
        bool dev = block.chainid == 31337;
        require(dev || feed != address(0), "DeployProvingVault: ETH_USD_FEED required off-devnet");
        require(dev || usdc != address(0), "DeployProvingVault: USDC required off-devnet");

        _startBroadcast();

        if (feed == address(0)) {
            MockEthUsdFeed mock = new MockEthUsdFeed();
            // Fresh as of now: the vault treats a stale answer as no answer, and a feed left at
            // its `updatedAt = 1` default is stale by roughly the age of the unix epoch.
            mock.set(3_000e8, block.timestamp);
            feed = address(mock);
        }
        if (usdc == address(0)) {
            usdc = address(new TestUSDC());
        }

        // The sanity band. `maxPerRootUsd` is denominated in oracle-USD and the ETH leg converts at
        // the same oracle, so a low-but-fresh price caps nothing: at $1/ETH a $50 claim withdraws
        // 50 ETH. An out-of-band answer is treated as no answer.
        //
        // Staleness default (ORCL-1, 2026-08-13 audit): mainnet Chainlink ETH/USD heartbeats
        // hourly, so accepting a 24h-old answer would price claims off a day-old market. Default
        // to heartbeat + 50% grace off-devnet; the 24h default survives only for dev, whose mock
        // feed is stamped once at deploy and would otherwise go stale mid-session.
        ProvingVault vault = new ProvingVault(
            IInstanceRegistry(instanceRegistry),
            IERC20(usdc),
            IEthUsdFeed(feed),
            uint64(vm.envOr("FEED_MAX_STALENESS", dev ? uint256(86_400) : uint256(5_400))),
            vm.envOr("MIN_ETH_USD", uint256(100e8)),
            vm.envOr("MAX_ETH_USD", uint256(100_000e8)),
            deployer, // FEE_SETTER_ROLE
            deployer // admin
        );
        provingVault = address(vault);

        // Price a root by size band, so a claim pays something the moment an instance is funded.
        // $5 / $10 / $15 for <=1k, <=20k, <=200k inputs.
        bytes32 program = keccak256("trust-graph");
        vault.setFeePerRootUsd(program, 1, 5e8);
        vault.setFeePerRootUsd(program, 2, 10e8);
        vault.setFeePerRootUsd(program, 3, 15e8);

        vm.stopBroadcast();

        console.log("ProvingVault:", provingVault);
        console.log("  ETH/USD feed:", feed, feed == vm.envOr("ETH_USD_FEED", address(0)) ? "" : "(dev mock)");
        console.log("  USDC:", usdc);

        string memory out = "provingVault";
        vm.serializeAddress(out, "eth_usd_feed", feed);
        vm.serializeAddress(out, "usdc", usdc);
        string memory json = vm.serializeAddress(out, "proving_vault", provingVault);
        vm.writeJson(json, string.concat(root, "/.docker/proving_vault_deploy.json"));
    }
}
