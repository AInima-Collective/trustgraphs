// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ProvingVault} from "src/vault/ProvingVault.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {TestUSDC} from "src/tokens/TestUSDC.sol";
import {MockZkVerifier} from "../mocks/MockZkVerifier.sol";
import {MockAccumulator} from "../mocks/MockAccumulator.sol";
import {MockEthUsdFeed} from "../mocks/MockEthUsdFeed.sol";

/// @notice An 18-decimal stablecoin. The vault's constructor asserts the FEED reports 8 decimals
///         but never asks the stablecoin anything, while `_pay`/`_payableUsd` hardcode `1e6`.
contract Stable18 is ERC20 {
    constructor() ERC20("Eighteen Decimal Stable", "S18") {}

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title PashovMath_VaultStableDecimals
/// @notice `ProvingVault` hardcodes the stablecoin scale as `1e6` in three places and never
///         asserts `decimals()`, unlike the price feed. A vault deployed against an 18-decimal
///         stablecoin misreports its own solvency by 1e12x — silently, with no revert anywhere.
contract PashovMath_VaultStableDecimalsTest is Test {
    ProvingVault vault6;
    ProvingVault vault18;
    InstanceRegistry registry;
    MerkleSnapshot snapshot;
    MockAccumulator accer;
    MockZkVerifier verifier;
    MockEthUsdFeed feed;
    TestUSDC usdc6;
    Stable18 stable18;

    bytes32 constant INSTANCE = keccak256("net-1");
    bytes32 constant PROGRAM = keccak256("trust-graph");
    bytes32 constant PARAMS = keccak256("params-v1");

    address constitutional = address(0xC047);
    address operational = address(0x0BE7);
    address feeSetter = address(0xFEE5);
    address admin = address(0xAD41);

    function setUp() public {
        verifier = new MockZkVerifier();
        accer = new MockAccumulator();
        snapshot = new MerkleSnapshot(verifier, PARAMS, accer, constitutional, operational);
        registry = new InstanceRegistry(address(this));
        usdc6 = new TestUSDC();
        stable18 = new Stable18();
        feed = new MockEthUsdFeed();

        // Identical deployments; only the stablecoin's decimals differ. Neither reverts.
        vault6 = new ProvingVault(registry, usdc6, feed, 1 hours, 100e8, 100_000e8, feeSetter, admin);
        vault18 = new ProvingVault(registry, stable18, feed, 1 hours, 100e8, 100_000e8, feeSetter, admin);

        registry.register(
            INSTANCE,
            IInstanceRegistry.Instance({
                program: PROGRAM,
                snapshot: address(snapshot),
                verifier: address(verifier),
                registryOrAccumulator: address(accer),
                paramsHash: PARAMS
            })
        );

        vm.startPrank(feeSetter);
        vault6.setFeePerRootUsd(PROGRAM, 1, 10e8); // $10 per root
        vault18.setFeePerRootUsd(PROGRAM, 1, 10e8);
        vm.stopPrank();

        vm.warp(1_000_000);
        vm.fee(10 gwei);
        feed.set(3_000e8, block.timestamp);
    }

    /// The constructor rejects a wrong-decimals FEED but silently accepts a wrong-decimals TOKEN.
    function test_ConstructorChecksFeedDecimalsButNotTokenDecimals() public view {
        assertEq(stable18.decimals(), 18);
        assertTrue(address(vault18) != address(0), "construction did not revert");
    }

    /// 1,000 tokens of an 18-decimal stablecoin are booked as one QUADRILLION dollars.
    function test_PayableUsdIsOverstatedByOneTrillionX() public {
        uint256 cp = _mint(bytes32(uint256(1)), 10, 100);

        _fund6(1_000e6);
        _policy6();
        uint256 payable6 = vault6.quote(INSTANCE, cp).payableUsd;
        assertEq(payable6, 1_000e8, "6dp: 1000 tokens read as $1,000");

        _fund18(1_000e18);
        _policy18();
        uint256 payable18 = vault18.quote(INSTANCE, cp).payableUsd;

        // 1_000e18 * 1e8 / 1e6 == 1e23, i.e. the vault believes it holds $1,000,000,000,000,000.
        assertEq(payable18, 1e23, "18dp: 1000 tokens read as $1e15");
        assertEq(payable18 / payable6, 1e12, "exactly 1e12x overstated");
    }

    /*//////////////////////////////////////////////////////////////
                                 HELPERS
    //////////////////////////////////////////////////////////////*/

    function _fund6(uint256 amount) internal {
        usdc6.mint(address(this), amount);
        usdc6.approve(address(vault6), amount);
        vault6.depositUSDC(INSTANCE, amount);
    }

    function _fund18(uint256 amount) internal {
        stable18.mint(address(this), amount);
        stable18.approve(address(vault18), amount);
        vault18.depositUSDC(INSTANCE, amount);
    }

    function _mint(bytes32 acc, uint64 leafCount, uint64 blockNumber) internal returns (uint256) {
        accer.setState(acc, leafCount);
        vm.roll(blockNumber);
        return snapshot.trigger();
    }

    function _policy6() internal {
        vm.prank(constitutional);
        vault6.setPolicy(INSTANCE, 0, 50e8);
    }

    function _policy18() internal {
        vm.prank(constitutional);
        vault18.setPolicy(INSTANCE, 0, 50e8);
    }

    receive() external payable {}
}
