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

/// @notice INVARIANT under attack: "one proven statement is paid at most once, and every applied
///         checkpoint's own statement is what gets marked". `ProvingVault._terms` derives the
///         statement from an `outputRoot` argument; `submitAndClaim` passes the root it is about
///         to file, but `claim` passes `snapshot.getLatestState().root` — the newest state, not
///         the state that belongs to `checkpointId`.
contract PashovInv_PaidStatement is Test {
    ProvingVault vault;
    InstanceRegistry registry;
    MerkleSnapshot snapshot;
    MockAccumulator accer;
    MockZkVerifier verifier;
    MockEthUsdFeed feed;
    TestUSDC usdc;

    bytes32 constant INSTANCE = keccak256("inv-net");
    bytes32 constant PROGRAM = keccak256("trust-graph");
    bytes32 constant PARAMS = keccak256("params-v1");

    bytes32 constant IPFS = bytes32(uint256(0x1F5));
    string constant CID = "bafkreiexamplecidstring";
    uint256 constant TOTAL = 1_000_000 ether;

    // Constant across checkpoints: exactly the shape a `trust-compose` instance has
    // (CompositionSourceAccumulator.leafCount() == policy source count, anchorCount == 0), and
    // reachable on any instance whose two lanes can move without changing either count.
    uint64 constant LEAVES = 5;

    address constitutional = address(0xC047);
    address operational = address(0x0BE7);
    address feeSetter = address(0xFEE5);
    address vaultAdmin = address(0xAD41);

    address proverA = address(0xA11CE);
    address proverB = address(0xB0B);

    function setUp() public {
        verifier = new MockZkVerifier();
        accer = new MockAccumulator();
        snapshot = new MerkleSnapshot(verifier, PARAMS, accer, constitutional, operational);
        registry = new InstanceRegistry(address(this));
        usdc = new TestUSDC();
        feed = new MockEthUsdFeed();
        vault = new ProvingVault(registry, usdc, feed, 1 hours, 100e8, 100_000e8, feeSetter, vaultAdmin);

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
        vault.setFeePerRootUsd(PROGRAM, 1, 10 * usdScale);

        vm.warp(1_000_000);
        vm.fee(1);
        feed.set(3_000e8, block.timestamp);

        // Fund the tank and enable payouts with no cadence gate.
        vm.deal(address(this), 100 ether);
        vault.depositETH{value: 50 ether}(INSTANCE);
        uint96 cap = uint96(1_000 * usdScale);
        vm.prank(constitutional);
        vault.setPolicy(INSTANCE, 0, cap);
    }

    receive() external payable {}

    /// Mint a checkpoint whose lane-1 leafCount is UNCHANGED but whose `acc` moved, so
    /// `trigger()`'s NoNewInputs guard passes while `(leafCount, anchorCount)` stays constant.
    function _mint(bytes32 acc, uint64 blockNumber) internal returns (uint256 id) {
        accer.setState(acc, LEAVES);
        vm.roll(blockNumber);
        id = snapshot.trigger();
    }

    function _submit(uint256 cpId, bytes32 root, address recipient) internal {
        snapshot.submitProof(cpId, root, IPFS, CID, TOTAL, bytes32(0), recipient, hex"");
    }

    function _statement(uint64 leafCount, uint64 anchorCount, bytes32 root) internal view returns (bytes32) {
        return keccak256(abi.encode(address(snapshot), leafCount, anchorCount, root));
    }

    /*//////////////////////////////////////////////////////////////
      DIRECTION 1 — `claim` marks a statement that belongs to a
      DIFFERENT checkpoint, permanently destroying that checkpoint's
      bounty.
    //////////////////////////////////////////////////////////////*/
    function test_ClaimMarksAnotherCheckpointsStatementAndBurnsItsBounty() public {
        bytes32 R0 = keccak256("root-0");
        bytes32 R1 = keccak256("root-1");

        uint256 cp0 = _mint(keccak256("acc-0"), 100);
        _submit(cp0, R0, proverA);

        uint256 cp1 = _mint(keccak256("acc-1"), 200);
        _submit(cp1, R1, proverB);

        // Neither checkpoint has been settled yet (both roots landed through the permissionless
        // `submitProof`, which is exactly the copier scenario `claim` exists for).
        assertFalse(vault.isClaimed(INSTANCE, cp0));
        assertFalse(vault.isClaimed(INSTANCE, cp1));

        // Anyone settles the OLDER checkpoint.
        vault.claim(INSTANCE, cp0);
        assertTrue(vault.isClaimed(INSTANCE, cp0), "cp0 paid");
        assertGt(vault.creditOf(proverA, address(0)), 0, "proverA credited");

        // INVARIANT BROKEN: the statement the vault recorded is cp1's, not cp0's.
        // cp1's prover can now never be paid.
        vm.expectRevert(
            abi.encodeWithSelector(IProvingVault.StatementAlreadyPaid.selector, _statement(LEAVES, 0, R1))
        );
        vault.claim(INSTANCE, cp1);

        assertEq(vault.creditOf(proverB, address(0)), 0, "proverB permanently unpaid");
    }

    /*//////////////////////////////////////////////////////////////
      DIRECTION 2 — the checkpoint's REAL statement is never marked,
      so the identical proven statement gets paid a second time.
    //////////////////////////////////////////////////////////////*/
    function test_TheSameProvenStatementIsPaidTwice() public {
        bytes32 R0 = keccak256("root-0");
        bytes32 R1 = keccak256("root-1");

        uint256 cp0 = _mint(keccak256("acc-0"), 100);
        _submit(cp0, R0, proverA);

        uint256 cp1 = _mint(keccak256("acc-1"), 200);
        _submit(cp1, R1, proverB);

        // Settle cp0 while cp1's state is the latest -> vault records cp1's statement.
        vault.claim(INSTANCE, cp0);
        assertTrue(vault.isClaimed(INSTANCE, cp0));

        // A later checkpoint reproduces the EXACT statement cp0 already paid for:
        // same snapshot, same (leafCount, anchorCount), same output root R0.
        uint256 cp2 = _mint(keccak256("acc-2"), 300);
        _submit(cp2, R0, proverA);

        uint256 creditBefore = vault.creditOf(proverA, address(0));
        vault.claim(INSTANCE, cp2);
        uint256 creditAfter = vault.creditOf(proverA, address(0));

        // `_paidStatement` was supposed to make this impossible.
        assertGt(creditAfter, creditBefore, "same statement paid a second time");
        assertEq(
            _statement(LEAVES, 0, R0),
            keccak256(abi.encode(address(snapshot), LEAVES, uint64(0), R0)),
            "statements identical"
        );
    }

    /*//////////////////////////////////////////////////////////////
      INVARIANT BROKEN #3 — `submitAndClaim(minPayoutUsd = 0)` is
      documented as "land it regardless of payment", and every other
      ineligibility reason honours that by `_skip`-ing. The
      `_requireUnpaidStatement` guard is the one hard REVERT inside
      `_settle`, so it takes the already-verified `submitProof` down
      with it and the proven root never lands.
    //////////////////////////////////////////////////////////////*/
    function test_DuplicateStatementRevertsTheRootInsteadOfSkippingPayment() public {
        bytes32 R0 = keccak256("root-0");

        uint256 cp0 = _mint(keccak256("acc-0"), 100);
        IProvingVault.SubmitArgs memory a0 = IProvingVault.SubmitArgs({
            checkpointId: cp0,
            outputRoot: R0,
            ipfsHash: IPFS,
            ipfsHashCid: CID,
            totalValue: TOTAL,
            skippedDigest: bytes32(0),
            recipient: proverA,
            proof: hex"",
            minPayoutUsd: 0
        });
        vault.submitAndClaim(INSTANCE, a0);
        assertEq(snapshot.lastAppliedCheckpoint(), cp0);

        // A later checkpoint over an unchanged source set: same (leafCount, anchorCount) and the
        // same proven output root. This is the STEADY STATE of a `trust-compose` instance whose
        // sources have not moved, because `CompositionSourceAccumulator.acc()` folds
        // `block.number` into the capture and so never trips `trigger()`'s NoNewInputs guard.
        uint256 cp1 = _mint(keccak256("acc-1"), 200);
        IProvingVault.SubmitArgs memory a1 = a0;
        a1.checkpointId = cp1;

        vm.expectRevert(
            abi.encodeWithSelector(IProvingVault.StatementAlreadyPaid.selector, _statement(LEAVES, 0, R0))
        );
        vault.submitAndClaim(INSTANCE, a1);

        // The proof was valid, the caller asked for no minimum payout, and the root still did not
        // land: `lastAppliedCheckpoint` is unchanged.
        assertEq(snapshot.lastAppliedCheckpoint(), cp0, "root rolled back with the payment");

        // Contrast: an ineligible-but-not-duplicate claim DOES land the root.
        uint256 cp2 = _mint(keccak256("acc-2"), 300);
        vm.prank(constitutional);
        vault.setPolicy(INSTANCE, 0, 0); // PolicyDisabled -> `_skip`
        IProvingVault.SubmitArgs memory a2 = a0;
        a2.checkpointId = cp2;
        a2.outputRoot = keccak256("root-2");
        vault.submitAndClaim(INSTANCE, a2);
        assertEq(snapshot.lastAppliedCheckpoint(), cp2, "skip path lands the root");
    }
}
