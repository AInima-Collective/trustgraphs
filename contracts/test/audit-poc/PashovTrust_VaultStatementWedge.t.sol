// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {ProvingVault} from "src/vault/ProvingVault.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {TestUSDC} from "src/tokens/TestUSDC.sol";
import {MockZkVerifier} from "../mocks/MockZkVerifier.sol";
import {MockAccumulator} from "../mocks/MockAccumulator.sol";
import {MockEthUsdFeed} from "../mocks/MockEthUsdFeed.sol";

/// @title PashovTrust_VaultStatementWedge
/// @notice SEAM: `ProvingVault._settle` has TWO refusal shapes for the same class of condition and
///         they are not economically symmetric.
///
///         Every "we cannot pay for this root" branch (`PolicyDisabled`, `CadenceNotElapsed`,
///         `UnknownProgram`, `PriceFeedUnavailable`, `InsufficientBalance`) calls `_skip`, which
///         lets the already-forwarded `submitProof` STAND - "a root that cannot be paid for is
///         still a root". `_requireUnpaidStatement` is the one exception: it REVERTS, and because
///         it runs AFTER `snapshot.submitProof(...)` inside the same transaction, the revert also
///         rolls the accepted root back. The refusal that costs the prover the most is the only
///         one that also costs the community its epoch.
///
///         The condition is reachable on any accumulator whose `leafCount` is not monotonic, which
///         is exactly `CompositionSourceAccumulator` (`leafCount() = _policy.length`, a constant
///         2-8) - and whose `acc()` is `sha256(manifest)` over a manifest containing
///         `block.number`, so `MerkleSnapshot.trigger()`'s "no movement" guard can never fire
///         there either. Two epochs whose sources produced the same allocation therefore mint two
///         distinct checkpoints, and the second one's root can never be landed through the vault.
///
///         The mock below reproduces exactly that shape: `acc` moves every epoch, `leafCount` does
///         not, lane 2 is empty, and the composed `outputRoot` repeats.
contract PashovTrust_VaultStatementWedge is Test {
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

    // The composed allocation root. Identical across two epochs because no source moved.
    bytes32 internal constant ROOT = bytes32(uint256(0xA110C));
    bytes32 internal constant IPFS = bytes32(uint256(0x1F5));
    string internal constant CID = "bafkreicomposecid";
    uint256 internal constant TOTAL = 1_000 ether;

    // `CompositionSourceAccumulator.leafCount()` is the policy source count: constant.
    uint64 internal constant SOURCE_COUNT = 3;

    address internal constitutional = address(0xC047);
    address internal operational = address(0x0BE7);
    address internal feeSetter = address(0xFEE5);
    address internal admin = address(0xAD41);
    address internal prover = address(0xA11CE);

    receive() external payable {}

    function setUp() public {
        verifier = new MockZkVerifier();
        accer = new MockAccumulator();
        snapshot = new MerkleSnapshot(verifier, PARAMS, accer, constitutional, operational);
        registry = new InstanceRegistry(address(this));
        usdc = new TestUSDC();
        feed = new MockEthUsdFeed();
        vault = new ProvingVault(registry, usdc, feed, 1 hours, 100e8, 100_000e8, feeSetter, admin);

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

        // trust-compose is flat-banded at 3 (`ProvingVault.bandOf`).
        uint256 usdUnit = vault.USD();
        vm.prank(feeSetter);
        vault.setFeePerRootUsd(PROGRAM, 3, 15 * usdUnit);

        vm.warp(1_000_000);
        vm.fee(10 gwei);
        feed.set(3_000e8, block.timestamp);

        // Fund the tank and open the policy (no cadence limit, so cadence never masks the result).
        vm.deal(address(this), 100 ether);
        vault.depositETH{value: 10 ether}(INSTANCE);
        uint96 cap = uint96(50 * usdUnit);
        vm.prank(constitutional);
        vault.setPolicy(INSTANCE, 0, cap);
    }

    /// Mint one epoch checkpoint. `acc` moves (compose folds `block.number` into its manifest),
    /// `leafCount` does not (it is the policy's source count).
    function _mintEpoch(uint256 epoch) internal returns (uint256 id) {
        accer.setState(keccak256(abi.encode("capture", epoch)), SOURCE_COUNT);
        vm.roll(block.number + 100);
        id = snapshot.trigger();
    }

    function _args(uint256 checkpointId, address recipient) internal pure returns (IProvingVault.SubmitArgs memory) {
        return IProvingVault.SubmitArgs({
            checkpointId: checkpointId,
            outputRoot: ROOT, // the SAME composed allocation two epochs running
            ipfsHash: IPFS,
            ipfsHashCid: CID,
            totalValue: TOTAL,
            skippedDigest: bytes32(0),
            recipient: recipient,
            proof: hex"",
            minPayoutUsd: 0 // "land it regardless of payment" - the operator's safe setting
        });
    }

    function test_RepeatedStatementRevertsAndTheRootNeverLands() public {
        // --- Epoch 1: normal paid claim. -------------------------------------------------------
        uint256 cp1 = _mintEpoch(1);
        vm.prank(prover);
        vault.submitAndClaim(INSTANCE, _args(cp1, prover));
        assertTrue(snapshot.hasAppliedCheckpoint());
        assertEq(snapshot.lastAppliedCheckpoint(), cp1);
        assertGt(vault.creditOf(prover, address(0)), 0, "epoch 1 paid the prover");

        // `trigger()`'s no-movement guard did NOT fire, because a compose `acc()` moves every block.
        uint256 cp2 = _mintEpoch(2);
        assertEq(cp2, cp1 + 1, "a second checkpoint minted even though no source moved");

        // --- Epoch 2: same composed allocation, so the vault's `statement` repeats. -------------
        //     `keccak256(abi.encode(snapshot, leafCount, anchorCount, outputRoot))` is identical:
        //     leafCount is the constant source count, anchorCount is 0, outputRoot repeats.
        bytes32 statement = keccak256(abi.encode(address(snapshot), SOURCE_COUNT, uint64(0), ROOT));
        statement; // documented for the report; the vault keeps it in a private mapping.

        vm.prank(prover);
        vm.expectRevert(abi.encodeWithSignature("StatementAlreadyPaid(bytes32)", statement));
        vault.submitAndClaim(INSTANCE, _args(cp2, prover));

        // The refusal rolled back the root as well: checkpoint 2 is still unproven on chain even
        // though the prover supplied a valid proof and asked for NO minimum payout.
        assertEq(snapshot.lastAppliedCheckpoint(), cp1, "epoch 2's root was rolled back with the payment");

        // Contrast: an empty tank is refused through `_skip`, and the root LANDS anyway.
        // Drain the account so `_pay` can move nothing, then prove a genuinely new statement.
        vm.prank(constitutional);
        vault.requestWithdrawal(INSTANCE, 10 ether, 0);
        uint64 notice = vault.WITHDRAWAL_NOTICE();
        vm.warp(block.timestamp + notice + 1);
        feed.set(3_000e8, block.timestamp);
        vm.prank(constitutional);
        vault.executeWithdrawal(INSTANCE, constitutional);

        uint256 cp3 = _mintEpoch(3);
        IProvingVault.SubmitArgs memory a3 = _args(cp3, prover);
        a3.outputRoot = bytes32(uint256(0xB0B)); // a different allocation: a fresh statement
        vm.prank(prover);
        vault.submitAndClaim(INSTANCE, a3);
        assertEq(snapshot.lastAppliedCheckpoint(), cp3, "the unpayable-but-new root LANDED via _skip");
    }
}
