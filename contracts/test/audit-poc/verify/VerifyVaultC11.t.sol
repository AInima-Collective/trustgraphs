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

/// @notice C11 direction check: which way does the hardcoded `1e6` cut?
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

    /// A LOWER-decimal token overpays: a $10 fee moves 1e6 base units = 10,000 whole tokens.
    function test_LowerDecimalTokenOverpaysTheProverByOneHundredX() public {
        Stable2 s2 = new Stable2();
        ProvingVault vault = new ProvingVault(registry, s2, feed, 1 hours, 100e8, 100_000e8, address(this), address(this));
        uint256 usdUnit = vault.USD();
        vault.setFeePerRootUsd(PROGRAM, 1, 10 * usdUnit); // $10

        s2.mint(address(this), 1_000_000e2); // one million whole tokens
        s2.approve(address(vault), type(uint256).max);
        vault.depositUSDC(INSTANCE, 1_000_000e2);
        uint96 cap = uint96(50 * usdUnit);
        vm.prank(constitutional);
        vault.setPolicy(INSTANCE, 0, cap);

        accer.setState(keccak256("a"), 10);
        vm.roll(100);
        uint256 cp = snapshot.trigger();

        IProvingVault.SubmitArgs memory a;
        a.checkpointId = cp;
        a.outputRoot = keccak256("r");
        a.ipfsHash = bytes32(uint256(1));
        a.ipfsHashCid = "cid";
        a.totalValue = 1;
        a.recipient = prover;
        vault.submitAndClaim(INSTANCE, a);

        // $10 of a 2-decimal token is 1_000 base units. The vault moved 1_000_000.
        assertEq(vault.creditOf(prover, address(s2)), 10e6, "paid 1e6 base units for a $10 fee");
        assertEq(vault.creditOf(prover, address(s2)) / 1_000, 10_000, "10,000x the intended amount");
    }

    /// ...and the whole `payableUsd` solvency read is off by the same factor, so the prover's own
    /// `minPayoutUsd` guard cannot detect it.
    function test_PayableUsdIsWrongInBothDirections() public {
        Stable2 s2 = new Stable2();
        ProvingVault v2 = new ProvingVault(registry, s2, feed, 1 hours, 100e8, 100_000e8, address(this), address(this));
        TestUSDC six = new TestUSDC();
        ProvingVault v6 = new ProvingVault(registry, six, feed, 1 hours, 100e8, 100_000e8, address(this), address(this));
        uint256 usdUnit = v2.USD();
        v2.setFeePerRootUsd(PROGRAM, 1, 10 * usdUnit);
        v6.setFeePerRootUsd(PROGRAM, 1, 10 * usdUnit);

        s2.mint(address(this), 1_000e2);
        s2.approve(address(v2), type(uint256).max);
        v2.depositUSDC(INSTANCE, 1_000e2); // 1,000 whole tokens
        six.mint(address(this), 1_000e6);
        six.approve(address(v6), type(uint256).max);
        v6.depositUSDC(INSTANCE, 1_000e6); // 1,000 whole tokens

        accer.setState(keccak256("a"), 10);
        vm.roll(100);
        uint256 cp = snapshot.trigger();
        uint96 cap = uint96(50 * usdUnit);
        vm.startPrank(constitutional);
        v2.setPolicy(INSTANCE, 0, cap);
        v6.setPolicy(INSTANCE, 0, cap);
        vm.stopPrank();

        assertEq(v6.quote(INSTANCE, cp).payableUsd, 1_000e8, "6dp: $1,000");
        assertEq(v2.quote(INSTANCE, cp).payableUsd, 1e7, "2dp: the same 1,000 tokens read as $0.10 (1e4x understated)");
    }
}
