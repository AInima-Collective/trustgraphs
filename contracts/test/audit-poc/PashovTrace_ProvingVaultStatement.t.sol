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

/// @notice Audit PoC (execution-trace pass).
///
/// Models a `trust-compose` instance. The two facts that matter are both taken verbatim from
/// production code, not invented for the test:
///
///   * `CompositionSourceAccumulator.leafCount()` returns `uint64(_policy.length)` — the SOURCE
///     COUNT — and `checkpoint()` stores that same constant, so every checkpoint of a compose
///     instance with an unchanged policy carries the SAME `leafCount`.
///   * `CompositionSourceAccumulator.acc()` is `sha256(manifest)` and the manifest header embeds
///     `uint64(block.number)`, so `acc` always moves and `MerkleSnapshot.trigger()`'s
///     `NoNewInputs` guard never fires.
///   * A compose instance has NO anchor registry (`TrustComposeFactory` never calls
///     `setAnchorRegistry`), so `anchorCount == 0` and `checkpointWorkCount == 0` forever.
///
/// `MockAccumulator` reproduces exactly that shape: constant `leafCount`, moving `acc`.
contract PashovTrace_ProvingVaultStatement is Test {
    ProvingVault vault;
    InstanceRegistry registry;
    MerkleSnapshot snapshot;
    MockAccumulator accer;
    MockZkVerifier verifier;
    MockEthUsdFeed feed;
    TestUSDC usdc;

    bytes32 constant INSTANCE = keccak256("compose-1");
    bytes32 constant PROGRAM = keccak256("trust-compose");
    bytes32 constant PARAMS = keccak256("params-v1");

    bytes32 constant ROOT0 = bytes32(uint256(0xA0));
    bytes32 constant ROOT1 = bytes32(uint256(0xB1));
    bytes32 constant IPFS = bytes32(uint256(0x1F5));
    string constant CID = "bafkreiexamplecidstring";
    uint256 constant TOTAL = 1_000_000 ether;

    /// The compose policy has 3 sources; that never changes across the test.
    uint64 constant SOURCE_COUNT = 3;

    address constitutional = address(0xC047);
    address operational = address(0x0BE7);
    address feeSetter = address(0xFEE5);
    address admin = address(0xAD41);
    address alice = address(0xA11CE); // prover of checkpoint 0
    address bob = address(0xB0B); // prover of checkpoint 1

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

        // trust-compose is flat-banded at 3 (ProvingVault.bandOf).
        uint256 usdUnit = vault.USD();
        vm.prank(feeSetter);
        vault.setFeePerRootUsd(PROGRAM, 3, 10 * usdUnit);

        vm.warp(1_000_000);
        vm.fee(10 gwei);
        feed.set(3_000e8, block.timestamp);

        vm.deal(address(this), 100 ether);
        vault.depositETH{value: 10 ether}(INSTANCE);

        // Cadence 0 so nothing is masked by CadenceNotElapsed; cap $50/root.
        uint96 cap = uint96(50 * usdUnit);
        vm.prank(constitutional);
        vault.setPolicy(INSTANCE, 0, cap);
    }

    /// Freeze a checkpoint the way `trigger()` does: `acc` moves, `leafCount` is constant.
    function _mint(bytes32 acc, uint64 blockNumber) internal returns (uint256 id) {
        accer.setState(acc, SOURCE_COUNT);
        vm.roll(blockNumber);
        id = snapshot.trigger();
    }

    function _submitDirect(uint256 checkpointId, bytes32 root, address recipient) internal {
        snapshot.submitProof(checkpointId, root, IPFS, CID, TOTAL, bytes32(0), recipient, hex"");
    }

    function _args(uint256 checkpointId, bytes32 root, address recipient)
        internal
        pure
        returns (IProvingVault.SubmitArgs memory)
    {
        return IProvingVault.SubmitArgs({
            checkpointId: checkpointId,
            outputRoot: root,
            ipfsHash: IPFS,
            ipfsHashCid: CID,
            totalValue: TOTAL,
            skippedDigest: bytes32(0),
            recipient: recipient,
            proof: hex"",
            minPayoutUsd: 0
        });
    }

    receive() external payable {}

    /*//////////////////////////////////////////////////////////////
      FINDING A — `claim()` prices the statement with the WRONG root
    //////////////////////////////////////////////////////////////*/

    /// `ProvingVault.claim` builds `Terms.statement` from `snapshot.getLatestState().root`
    /// instead of the root that the CLAIMED checkpoint produced. Once a newer checkpoint has
    /// landed, claiming an older one records a statement that belongs to the newer root — and
    /// that permanently poisons the newer checkpoint's own bounty.
    function test_ClaimUsesLatestRootNotCheckpointRoot_BricksTheNextBounty() public {
        // Two epochs, two DIFFERENT proven roots, one unchanged compose policy.
        uint256 ck0 = _mint(keccak256("cap-0"), 100);
        _submitDirect(ck0, ROOT0, alice);

        uint256 ck1 = _mint(keccak256("cap-1"), 200);
        _submitDirect(ck1, ROOT1, bob);

        assertEq(snapshot.getLatestState().root, ROOT1, "latest is checkpoint 1's root");

        // Alice's bounty for checkpoint 0 is claimed AFTER checkpoint 1 landed.
        // `_terms` is handed ROOT1, so the recorded statement is
        //   keccak256(snapshot, 3, 0, ROOT1)  -- checkpoint 1's statement, not checkpoint 0's.
        vault.claim(INSTANCE, ck0);
        assertGt(vault.creditOf(alice, address(0)), 0, "alice was paid for checkpoint 0");

        // Bob's checkpoint 1 is a distinct proof of a distinct root, never paid for. Its real
        // statement is keccak256(snapshot, 3, 0, ROOT1) -- which the claim above just consumed.
        bytes32 collidedStatement = keccak256(abi.encode(address(snapshot), SOURCE_COUNT, uint64(0), ROOT1));
        vm.expectRevert(abi.encodeWithSelector(IProvingVault.StatementAlreadyPaid.selector, collidedStatement));
        vault.claim(INSTANCE, ck1);

        assertEq(vault.creditOf(bob, address(0)), 0, "bob's bounty is permanently unpayable");
    }

    /*//////////////////////////////////////////////////////////////
      FINDING B — a duplicate statement REVERTS instead of skipping,
      which rolls back the already-successful `submitProof`
    //////////////////////////////////////////////////////////////*/

    /// Every other ineligibility reason in `_settle` calls `_skip` (root lands, nobody is paid).
    /// `_requireUnpaidStatement` reverts. Because `_settle` runs AFTER `snapshot.submitProof`
    /// inside `submitAndClaim`, that revert unwinds the verified root as well. A compose instance
    /// whose sources published nothing new legitimately re-proves the same output root, so this is
    /// the normal case, not an edge case.
    function test_DuplicateStatementRevertsAndDiscardsTheVerifiedRoot() public {
        uint256 ck0 = _mint(keccak256("cap-0"), 100);
        vault.submitAndClaim(INSTANCE, _args(ck0, ROOT0, alice));
        assertEq(snapshot.lastAppliedCheckpoint(), ck0);

        // Next epoch. Sources published nothing, so the composed output root is identical.
        uint256 ck1 = _mint(keccak256("cap-1"), 200);

        bytes32 statement = keccak256(abi.encode(address(snapshot), SOURCE_COUNT, uint64(0), ROOT0));
        vm.expectRevert(abi.encodeWithSelector(IProvingVault.StatementAlreadyPaid.selector, statement));
        vault.submitAndClaim(INSTANCE, _args(ck1, ROOT0, alice));

        // The proof verified, `submitProof` succeeded, and the whole thing was thrown away.
        assertEq(snapshot.lastAppliedCheckpoint(), ck0, "checkpoint 1's root never landed");
        assertEq(snapshot.getStateCount(), 1, "only checkpoint 0 produced a state");

        // Contrast: an ineligibility that goes through `_skip` DOES land the root.
        vm.prank(constitutional);
        vault.setPolicy(INSTANCE, 0, 0); // PolicyDisabled -> _skip
        vault.submitAndClaim(INSTANCE, _args(ck1, ROOT0, alice));
        assertEq(snapshot.lastAppliedCheckpoint(), ck1, "the skip path lands the root");
    }
}
