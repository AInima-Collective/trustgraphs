// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {ProvingVault} from "src/vault/ProvingVault.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {TestUSDC} from "src/tokens/TestUSDC.sol";
import {MockZkVerifier} from "../../mocks/MockZkVerifier.sol";
import {MockAccumulator} from "../../mocks/MockAccumulator.sol";
import {MockEthUsdFeed} from "../../mocks/MockEthUsdFeed.sol";

/// @notice Why the two FAILING C4 siblings failed.
contract VerifyVaultSiblings is Test {
    ProvingVault internal vault;
    InstanceRegistry internal registry;
    MerkleSnapshot internal snapshot;
    MockAccumulator internal accer;
    MockZkVerifier internal verifier;
    MockEthUsdFeed internal feed;
    TestUSDC internal usdc;

    bytes32 internal constant INSTANCE = keccak256("compose-1");
    bytes32 internal constant PROGRAM = keccak256("trust-compose");
    bytes32 internal constant PARAMS = keccak256("compose-params-v1");
    bytes32 internal constant ROOT = bytes32(uint256(0xA110C));
    uint64 internal constant SOURCE_COUNT = 3;

    address internal constitutional = address(0xC047);
    address internal operational = address(0x0BE7);
    address internal prover = address(0xA11CE);

    receive() external payable {}

    /// ROOT CAUSE OF `OmegaPassB_ProvingVaultStatement` (`NoNewInputs()`): solc treats
    /// `block.number` as loop/tx-invariant and hoists it, so a SECOND `vm.roll(block.number + N)`
    /// in the same test body re-uses the value read before the FIRST roll. The block never
    /// advances, the block-derived compose `acc()` never moves, and `trigger()` fails closed.
    function test_Sibling1_RootCauseIsSolcHoistingBlockNumberAcrossVmRoll() public {
        vm.roll(1);
        vm.roll(block.number + 10);
        assertEq(block.number, 11, "first roll advanced");
        vm.roll(block.number + 10);
        // If solc re-read NUMBER this would be 21. It does not: the cheatcode got 11 again.
        assertEq(vm.getBlockNumber(), 11, "second roll was a no-op: block.number was hoisted");
    }

    /// Absolute rolls demonstrate the fixed behavior without the historical cheatcode artifact.
    function test_Sibling1_DistinctAccumulatorsWithSameRootBothLand() public {
        _setUpVault();

        accer.setState(keccak256("capture-1"), SOURCE_COUNT);
        vm.roll(1_000);
        uint256 cp0 = snapshot.trigger();
        vm.prank(prover);
        vault.submitAndClaim(INSTANCE, _args(cp0, ROOT, prover));
        assertGt(vault.creditOf(prover, address(0)), 0);

        accer.setState(keccak256("capture-2"), SOURCE_COUNT); // acc moved, leafCount did not
        vm.roll(1_100);
        uint256 cp1 = snapshot.trigger();
        assertEq(cp1, cp0 + 1, "second checkpoint minted");

        vm.prank(prover);
        vault.submitAndClaim(INSTANCE, _args(cp1, ROOT, prover));
        assertEq(snapshot.lastAppliedCheckpoint(), cp1, "second distinct proof landed");
    }

    /// ROOT CAUSE OF `PashovTrust_VaultStatementWedge` (`InsufficientBalance`): the failure is in
    /// the test's EPILOGUE, after both of its claims were already asserted. It funds 10 ether,
    /// spends part of it on the epoch-1 fee, then asks to withdraw the full 10 ether.
    function test_Sibling2_FailureIsInTheEpilogueNotTheClaim() public {
        _setUpVault();

        accer.setState(keccak256("capture-1"), SOURCE_COUNT);
        vm.roll(1_000);
        uint256 cp0 = snapshot.trigger();
        vm.prank(prover);
        vault.submitAndClaim(INSTANCE, _args(cp0, ROOT, prover));

        // The second distinct accumulator-bound proof lands and pays.
        accer.setState(keccak256("capture-2"), SOURCE_COUNT);
        vm.roll(1_100);
        uint256 cp1 = snapshot.trigger();
        vm.prank(prover);
        vault.submitAndClaim(INSTANCE, _args(cp1, ROOT, prover));
        assertEq(snapshot.lastAppliedCheckpoint(), cp1);

        // The epilogue's bug: the tank is no longer a round 10 ether.
        uint256 left = vault.accountOf(INSTANCE).ethBalance;
        assertLt(left, 10 ether, "the epoch-0 fee already left the tank");
        vm.prank(constitutional);
        vm.expectRevert(abi.encodeWithSelector(IProvingVault.InsufficientBalance.selector, uint128(left), uint128(0)));
        vault.requestWithdrawal(INSTANCE, 10 ether, 0);
    }

    function _setUpVault() internal {
        verifier = new MockZkVerifier();
        accer = new MockAccumulator();
        snapshot = new MerkleSnapshot(verifier, PARAMS, accer, constitutional, operational, "");
        vm.prank(constitutional);
        snapshot.enableStateProvenance();
        registry = new InstanceRegistry(address(this));
        usdc = new TestUSDC();
        feed = new MockEthUsdFeed();
        vault = new ProvingVault(registry, usdc, feed, 1 hours, 100e8, 100_000e8, address(this), address(this));
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
        uint256 usdUnit = vault.USD();
        vault.setFeePerRootUsd(PROGRAM, 3, 15 * usdUnit);
        vm.warp(1_000_000);
        vm.fee(10 gwei);
        feed.set(3_000e8, block.timestamp);
        vm.deal(address(this), 100 ether);
        vault.depositETH{value: 10 ether}(INSTANCE);
        uint96 cap = uint96(50 * vault.USD());
        vm.prank(constitutional);
        vault.setPolicy(INSTANCE, 0, cap);
    }

    function _args(uint256 cp, bytes32 root, address recipient)
        internal
        pure
        returns (IProvingVault.SubmitArgs memory a)
    {
        a.checkpointId = cp;
        a.outputRoot = root;
        a.ipfsHash = bytes32(uint256(0x1F5));
        a.ipfsHashCid = "bafkreicomposecid";
        a.totalValue = 1_000 ether;
        a.skippedDigest = bytes32(0);
        a.recipient = recipient;
        a.proof = "";
        a.minPayoutUsd = 0;
    }
}
