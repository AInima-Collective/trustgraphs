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

/// @notice An 18-decimal stablecoin that must be rejected by the vault's six-decimal accounting.
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
/// @notice Regression for L-1: constructor validation pins the token scale used by `_pay` and
///         `_payableUsd`, just as it already pins the price-feed scale.
contract PashovMath_VaultStableDecimalsTest is Test {
    ProvingVault vault6;
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

        vault6 = new ProvingVault(registry, usdc6, feed, 1 hours, 100e8, 100_000e8, feeSetter, admin);

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
        vm.stopPrank();

        vm.warp(1_000_000);
        vm.fee(10 gwei);
        feed.set(3_000e8, block.timestamp);
    }

    function test_ConstructorRejectsUnsupportedStablecoinDecimals() public {
        vm.expectRevert(abi.encodeWithSelector(ProvingVault.StablecoinDecimalsUnsupported.selector, 18));
        new ProvingVault(registry, stable18, feed, 1 hours, 100e8, 100_000e8, feeSetter, admin);
    }

    function test_SupportedSixDecimalStablecoinKeepsExactSolvencyMath() public {
        uint256 cp = _mint(bytes32(uint256(1)), 10, 100);

        _fund6(1_000e6);
        _policy6();
        uint256 payable6 = vault6.quote(INSTANCE, cp).payableUsd;
        assertEq(payable6, 1_000e8, "6dp: 1000 tokens read as $1,000");
    }

    /*//////////////////////////////////////////////////////////////
                                 HELPERS
    //////////////////////////////////////////////////////////////*/

    function _fund6(uint256 amount) internal {
        usdc6.mint(address(this), amount);
        usdc6.approve(address(vault6), amount);
        vault6.depositUSDC(INSTANCE, amount);
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

    receive() external payable {}
}
