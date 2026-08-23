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
import {MockZkVerifier} from "../../mocks/MockZkVerifier.sol";
import {MockAccumulator} from "../../mocks/MockAccumulator.sol";
import {MockEthUsdFeed} from "../../mocks/MockEthUsdFeed.sol";

contract Stable2 is ERC20 {
    constructor() ERC20("Two Decimal Stable", "S2") {}

    function decimals() public pure override returns (uint8) {
        return 2;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice L-1 verification: deployment pins the stablecoin to the six-decimal scale used in math.
contract VerifyVaultC11 is Test {
    InstanceRegistry registry;
    MerkleSnapshot snapshot;
    MockAccumulator accer;
    MockZkVerifier verifier;
    MockEthUsdFeed feed;

    bytes32 constant INSTANCE = keccak256("net-1");
    bytes32 constant PROGRAM = keccak256("trust-graph");
    bytes32 constant PARAMS = keccak256("params-v1");
    address constitutional = address(0xC047);
    address prover = address(0xA11CE);

    receive() external payable {}

    function setUp() public {
        verifier = new MockZkVerifier();
        accer = new MockAccumulator();
        snapshot = new MerkleSnapshot(verifier, PARAMS, accer, constitutional, address(0x0BE7));
        registry = new InstanceRegistry(address(this));
        feed = new MockEthUsdFeed();
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
        vm.warp(1_000_000);
        vm.fee(1);
        feed.set(3_000e8, block.timestamp);
    }

    function test_LowerDecimalTokenIsRejectedBeforeItCanOverpay() public {
        Stable2 s2 = new Stable2();
        vm.expectRevert(abi.encodeWithSelector(ProvingVault.StablecoinDecimalsUnsupported.selector, 2));
        new ProvingVault(registry, s2, feed, 1 hours, 100e8, 100_000e8, address(this), address(this));
    }

    function test_SupportedTokenReportsSolvencyAtThePinnedScale() public {
        Stable2 s2 = new Stable2();
        vm.expectRevert(abi.encodeWithSelector(ProvingVault.StablecoinDecimalsUnsupported.selector, 2));
        new ProvingVault(registry, s2, feed, 1 hours, 100e8, 100_000e8, address(this), address(this));

        TestUSDC six = new TestUSDC();
        ProvingVault v6 = new ProvingVault(registry, six, feed, 1 hours, 100e8, 100_000e8, address(this), address(this));
        uint256 usdUnit = v6.USD();

        six.mint(address(this), 1_000e6);
        six.approve(address(v6), type(uint256).max);
        v6.depositUSDC(INSTANCE, 1_000e6); // 1,000 whole tokens

        accer.setState(keccak256("a"), 10);
        vm.roll(100);
        uint256 cp = snapshot.trigger();
        uint96 cap = uint96(50 * usdUnit);
        vm.prank(constitutional);
        v6.setPolicy(INSTANCE, 0, cap);

        assertEq(v6.quote(INSTANCE, cp).payableUsd, 1_000e8, "6dp: $1,000");
    }
}
