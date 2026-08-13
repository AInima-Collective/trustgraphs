// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {ProvingVault} from "contracts/vault/ProvingVault.sol";
import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {InstanceRegistry} from "contracts/registry/InstanceRegistry.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {TestUSDC} from "contracts/tokens/TestUSDC.sol";
import {MockZkVerifier} from "../../mocks/MockZkVerifier.sol";
import {MockAccumulator} from "../../mocks/MockAccumulator.sol";
import {MockEthUsdFeed} from "../../mocks/MockEthUsdFeed.sol";
import {IEthUsdFeed} from "interfaces/vault/IEthUsdFeed.sol";

/// @notice A feed reporting 18 decimals, which every conversion in the vault would misread.
contract WrongDecimalsFeed is IEthUsdFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 3_000e18, block.timestamp, block.timestamp, 1);
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }
}

/// @notice A recipient that refuses ETH. Must never be able to revert a verified root.
contract RejectingRecipient {
    receive() external payable {
        revert("nope");
    }
}

/// @notice Reenters `submitAndClaim` from the credit withdrawal path.
contract ReentrantRecipient {
    ProvingVault public vault;
    bytes32 public instanceId;
    IProvingVault.SubmitArgs public args;
    bool public armed;

    function arm(ProvingVault v, bytes32 id, IProvingVault.SubmitArgs memory a) external {
        vault = v;
        instanceId = id;
        args = a;
        armed = true;
    }

    receive() external payable {
        if (armed) {
            armed = false;
            try vault.submitAndClaim(instanceId, args) {} catch {}
        }
    }

    function pull() external {
        vault.withdrawCredit(address(0), address(this));
    }
}

contract ProvingVaultTest is Test {
    ProvingVault vault;
    InstanceRegistry registry;
    MerkleSnapshot snapshot;
    MockAccumulator accer;
    MockZkVerifier verifier;
    MockEthUsdFeed feed;
    TestUSDC usdc;

    bytes32 constant INSTANCE = keccak256("net-1");
    bytes32 constant PROGRAM = keccak256("trust-graph");
    bytes32 constant PARAMS = keccak256("params-v1");

    bytes32 constant ROOT = bytes32(uint256(0xC0FFEE));
    bytes32 constant IPFS = bytes32(uint256(0x1F5));
    string constant CID = "bafkreiexamplecidstring";
    uint256 constant TOTAL = 1_000_000 ether;

    address constitutional = address(0xC047);
    address operational = address(0x0BE7);
    address feeSetter = address(0xFEE5);
    address admin = address(0xAD41);
    address alice = address(0xA11CE); // the honest prover
    address mallory = address(0x4A110); // the copier

    function setUp() public {
        verifier = new MockZkVerifier();
        accer = new MockAccumulator();
        snapshot = new MerkleSnapshot(verifier, PARAMS, accer, constitutional, operational);
        // Only the bound snapshot may mint checkpoints (issue #10).
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

        // $10 per root in the smallest band.
        vm.startPrank(feeSetter);
        vault.setFeePerRootUsd(PROGRAM, 1, 10 * vault.USD());
        vm.stopPrank();

        vm.warp(1_000_000);
        vm.fee(10 gwei);
        feed.set(3_000e8, block.timestamp);
    }

    /*///////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// Mint a checkpoint the way production does. `trigger()` refuses a checkpoint identical to
    /// the last one across both lanes, so every call here must actually move the accumulator.
    function _mint(bytes32 acc, uint64 leafCount, uint64 blockNumber) internal returns (uint256 id) {
        accer.setState(acc, leafCount);
        vm.roll(blockNumber);
        id = snapshot.trigger();
    }

    function _args(uint256 checkpointId, address recipient) internal pure returns (IProvingVault.SubmitArgs memory) {
        return _args(checkpointId, recipient, 0);
    }

    /// `minPayoutUsd` is the prover's own guard: below it, the whole claim reverts and nothing
    /// lands. Zero means "land it regardless of payment".
    function _args(uint256 checkpointId, address recipient, uint256 minPayoutUsd)
        internal
        pure
        returns (IProvingVault.SubmitArgs memory)
    {
        return IProvingVault.SubmitArgs({
            checkpointId: checkpointId,
            outputRoot: ROOT,
            ipfsHash: IPFS,
            ipfsHashCid: CID,
            totalValue: TOTAL,
            skippedDigest: bytes32(0),
            recipient: recipient,
            proof: hex"",
            minPayoutUsd: minPayoutUsd
        });
    }

    function _fund(uint256 ethAmount, uint256 usdcAmount) internal {
        if (ethAmount != 0) {
            vm.deal(address(this), address(this).balance + ethAmount);
            vault.depositETH{value: ethAmount}(INSTANCE);
        }
        if (usdcAmount != 0) {
            usdc.mint(address(this), usdcAmount);
            usdc.approve(address(vault), usdcAmount);
            vault.depositUSDC(INSTANCE, usdcAmount);
        }
    }

    function _policy(uint64 minInterval, uint256 maxUsd) internal {
        vm.prank(constitutional);
        vault.setPolicy(INSTANCE, minInterval, uint96(maxUsd));
    }

    /// Land a root through the vault, as `sender`, paying `recipient`.
    function _claim(uint256 checkpointId, address sender, address recipient)
        internal
        returns (uint256 feeUsd, uint256 gasUsd)
    {
        vm.prank(sender);
        return vault.submitAndClaim(INSTANCE, _args(checkpointId, recipient));
    }

    receive() external payable {}

    /*///////////////////////////////////////////////////////////////
                                BINDING
    //////////////////////////////////////////////////////////////*/

    function test_FirstDepositBindsTheSnapshotAndProgram() public {
        vm.expectEmit(true, true, true, true);
        emit IProvingVault.AccountBound(INSTANCE, address(snapshot), PROGRAM);
        _fund(1 ether, 0);

        IProvingVault.Account memory a = vault.accountOf(INSTANCE);
        assertEq(a.snapshot, address(snapshot));
        assertEq(a.program, PROGRAM);
        assertEq(a.ethBalance, 1 ether);
    }

    /// The registry's OPERATOR_ROLE can rewrite a directory row. It must not be able to redirect a
    /// funded community's balance to a snapshot of its choosing.
    function test_AHostileRegistryUpdateCannotRedirectAFundedBalance() public {
        _fund(1 ether, 0);
        address boundBefore = vault.accountOf(INSTANCE).snapshot;

        MockAccumulator rogueAcc = new MockAccumulator();
        MerkleSnapshot rogue = new MerkleSnapshot(verifier, PARAMS, rogueAcc, address(this), address(this));
        registry.update(
            INSTANCE,
            IInstanceRegistry.Instance({
                program: PROGRAM,
                snapshot: address(rogue),
                verifier: address(verifier),
                registryOrAccumulator: address(rogueAcc),
                paramsHash: PARAMS
            })
        );

        // Another deposit does not re-resolve.
        _fund(1 ether, 0);
        assertEq(vault.accountOf(INSTANCE).snapshot, boundBefore, "binding must survive the registry");

        // And a claim still forwards to the ORIGINAL snapshot: the rogue one has no checkpoints,
        // so a claim against it could not even be attempted through this account.
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);
        _claim(id, alice, alice);
        assertEq(snapshot.lastAppliedCheckpoint(), id, "the ORIGINAL snapshot got the root");
    }

    function test_DepositingToAnUnknownInstanceReverts() public {
        vm.deal(address(this), 1 ether);
        vm.expectRevert();
        vault.depositETH{value: 1 ether}(keccak256("nope"));
    }

    /*///////////////////////////////////////////////////////////////
                        THE FRONT-RUN SIMULATION
    //////////////////////////////////////////////////////////////*/

    /// The property the whole design exists for: copy a pending `submitAndClaim` out of the
    /// mempool and you pay the original prover their fee and refund yourself only gas.
    function test_FrontRunningPaysTheOriginalProverAndRefundsTheCopierOnlyGas() public {
        _fund(10 ether, 0);
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);

        // Mallory copies alice's transaction verbatim — the recipient is IN the journal, so
        // changing it would make the proof fail to verify (see MerkleSnapshot.t.sol). All Mallory
        // can change is who sends it.
        (uint256 feeUsd, uint256 gasUsd) = _claim(id, mallory, alice);

        assertGt(feeUsd, 0, "the fee was paid");
        assertGt(vault.creditOf(alice, address(0)), 0, "alice is owed the fee she never sent a tx for");
        assertEq(
            vault.creditOf(mallory, address(0)), _weiFor(gasUsd), "mallory is owed exactly her gas, and nothing else"
        );
        assertLt(
            vault.creditOf(mallory, address(0)),
            vault.creditOf(alice, address(0)),
            "copying is strictly worse than proving"
        );
    }

    function _weiFor(uint256 usdAmount) internal view returns (uint256) {
        return (usdAmount * 1e18) / 3_000e8;
    }

    /// One checkpoint, one bounty, ever.
    function test_PayOncePerCheckpoint() public {
        _fund(10 ether, 0);
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);
        _claim(id, alice, alice);

        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(IProvingVault.AlreadyClaimed.selector, INSTANCE, id));
        vault.submitAndClaim(INSTANCE, _args(id, mallory));
        assertTrue(vault.isClaimed(INSTANCE, id));
    }

    /// The bypass. `MerkleSnapshot.submitProof` is permissionless, so a griefer can lift the
    /// proof out of the mempool and land it DIRECTLY, outside the vault. The prover's
    /// `submitAndClaim` then reverts `StaleCheckpoint`, and because monotonicity is permanent the
    /// checkpoint could never be applied again — the fee was unpayable by anyone, forever, for the
    /// price of one transaction. Four agents found this; it defeated the interface's headline
    /// claim outright.
    ///
    /// `MerkleSnapshot` now records the journal's recipient per applied checkpoint, so the bounty
    /// survives the submission and `claim` pays it afterwards.
    function test_LandingTheProofDirectlyDoesNotStripTheBounty() public {
        _fund(10 ether, 0);
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);

        // Mallory copies the proof and bypasses the vault entirely. She must echo alice as the
        // recipient or the digest changes and nothing verifies.
        vm.prank(mallory);
        snapshot.submitProof(id, ROOT, IPFS, CID, TOTAL, bytes32(0), alice, hex"");
        assertEq(snapshot.lastAppliedCheckpoint(), id, "the root landed outside the vault");

        // Alice's own claim now reverts, exactly as the attack intends...
        vm.prank(alice);
        vm.expectRevert();
        vault.submitAndClaim(INSTANCE, _args(id, alice));

        // ...and she is paid anyway, against the recipient the journal committed.
        uint256 feeUsd = vault.claim(INSTANCE, id);
        assertGt(feeUsd, 0);
        assertGt(vault.creditOf(alice, address(0)), 0, "the bounty followed the journal");
        assertEq(vault.creditOf(mallory, address(0)), 0, "the copier bought nothing");
        assertTrue(vault.isClaimed(INSTANCE, id));
    }

    function test_ClaimIsPermissionlessButOnlyEverPaysTheJournalsRecipient() public {
        _fund(10 ether, 0);
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);
        vm.prank(mallory);
        snapshot.submitProof(id, ROOT, IPFS, CID, TOTAL, bytes32(0), alice, hex"");

        // Mallory may trigger the payment. It still goes to alice.
        vm.prank(mallory);
        vault.claim(INSTANCE, id);
        assertGt(vault.creditOf(alice, address(0)), 0);
        assertEq(vault.creditOf(mallory, address(0)), 0);
    }

    function test_ClaimingAnUnappliedCheckpointReverts() public {
        _fund(10 ether, 0);
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);
        vm.expectRevert(abi.encodeWithSelector(IProvingVault.CheckpointNotApplied2.selector, id));
        vault.claim(INSTANCE, id);
    }

    /*///////////////////////////////////////////////////////////////
                        THE PROVER'S OWN GUARD
    //////////////////////////////////////////////////////////////*/

    /// Every "zero the payout in the same block" attack — a front-run `setPolicy(0, 0)`, a
    /// drained tank, a hook rewriting the policy from inside the forwarded call — reduces to the
    /// same thing: the prover's work lands and pays nothing. `minPayoutUsd` is the prover's answer.
    /// Below it the whole call reverts, so the community gets a reverted transaction rather than a
    /// free root, and the checkpoint stays claimable.
    function test_MinPayoutRevertsRatherThanHandingOverAFreeRoot() public {
        _fund(10 ether, 0);
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);

        // The community front-runs with a zeroed policy.
        vm.prank(constitutional);
        vault.setPolicy(INSTANCE, 0, 0);

        // Hoisted: a `vault.USD()` inside the argument list would be the call `expectRevert`
        // latches onto.
        uint256 minPayout = 5 * vault.USD();
        IProvingVault.SubmitArgs memory args = _args(id, alice, minPayout);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IProvingVault.PayoutBelowMinimum.selector, 0, minPayout));
        vault.submitAndClaim(INSTANCE, args);

        // Nothing landed and nothing was consumed, so the prover can simply try again later.
        assertFalse(snapshot.hasAppliedCheckpoint(), "the root did not land");
        assertFalse(vault.isClaimed(INSTANCE, id));

        _policy(0, 1_000 * vault.USD());
        (uint256 feeUsd,) = _claim(id, alice, alice);
        assertGt(feeUsd, 0, "the same checkpoint pays once the policy is restored");
    }

    /// Zero means "land it regardless of payment" — the curated / self-proving setting.
    function test_AZeroMinimumStillLandsAnUnpaidRoot() public {
        _fund(0, 0);
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);
        vm.deal(address(this), 1 wei);
        vault.depositETH{value: 1 wei}(INSTANCE);
        (uint256 feeUsd,) = _claim(id, alice, alice);
        assertEq(feeUsd, 0);
        assertEq(snapshot.lastAppliedCheckpoint(), id, "correctness still fails open");
    }

    /// A zero payout must not consume the checkpoint's one-shot bounty slot. Marking it
    /// regardless meant a single missed oracle heartbeat destroyed that root's fee forever.
    function test_AZeroPayoutDoesNotBurnTheBountySlot() public {
        _fund(10 ether, 0);
        _policy(0, 1_000 * vault.USD());
        feed.set(3_000e8, block.timestamp - 2 hours); // feed goes stale
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);

        (uint256 feeUsd,) = _claim(id, alice, alice);
        assertEq(feeUsd, 0);
        assertFalse(vault.isClaimed(INSTANCE, id), "the slot survives a transient outage");

        // Feed recovers; the already-applied root is still claimable against the journal.
        feed.set(3_000e8, block.timestamp);
        uint256 paid = vault.claim(INSTANCE, id);
        assertGt(paid, 0, "and pays once the outage clears");
    }

    /*///////////////////////////////////////////////////////////////
                            THE PRICE FEED, BOUNDED
    //////////////////////////////////////////////////////////////*/

    /// `maxPerRootUsd` is denominated in oracle-USD and the ETH leg converts at the same oracle,
    /// so without a floor a crashed feed turns a $50 cap into no cap at all: at $1/ETH a $50 claim
    /// withdraws 50 ETH. An out-of-band answer is no answer.
    function test_AnAbsurdlyLowPriceIsNoPriceAtAll() public {
        _fund(10 ether, 0);
        _policy(0, 1_000 * vault.USD());
        feed.set(1e8, block.timestamp); // $1/ETH, fresh, and far below MIN_ETH_USD
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);

        (uint256 feeUsd,) = _claim(id, alice, alice);
        assertEq(feeUsd, 0, "priced at nothing rather than draining the tank");
        assertEq(vault.accountOf(INSTANCE).ethBalance, 10 ether, "not one wei left");
    }

    function test_AFutureDatedFeedDoesNotBrickTheVault() public {
        _fund(10 ether, 0);
        _policy(0, 1_000 * vault.USD());
        // `block.timestamp - updatedAt` would underflow and panic, reverting the whole claim —
        // turning "fail open on correctness" into a denial of root submission.
        feed.set(3_000e8, block.timestamp + 1 days);
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);

        (uint256 feeUsd,) = _claim(id, alice, alice);
        assertEq(feeUsd, 0);
        assertEq(snapshot.lastAppliedCheckpoint(), id, "the root still landed");
    }

    function test_AFeedWithTheWrongDecimalsIsRejectedAtDeployment() public {
        WrongDecimalsFeed bad = new WrongDecimalsFeed();
        vm.expectRevert(abi.encodeWithSelector(IProvingVault.FeedDecimalsUnsupported.selector, 18));
        new ProvingVault(registry, usdc, bad, 1 hours, 100e8, 100_000e8, feeSetter, admin);
    }

    /*///////////////////////////////////////////////////////////////
                    NO-MOVEMENT CHECKPOINTS
    //////////////////////////////////////////////////////////////*/

    /// The replay. The journal does not commit the checkpoint id, so two checkpoints with
    /// identical commitments accept the SAME proof — and on any accumulator without a
    /// `NoNewInputs` guard (the contributions mirror, the empty lane) a stranger could mint an
    /// unlimited run of them and collect a full bounty for each. `trigger()` now refuses a
    /// checkpoint identical to the last one across both lanes.
    function test_TriggerRefusesACheckpointNothingMoved() public {
        _mint(bytes32(uint256(1)), 5, 100);
        vm.roll(200);
        vm.expectRevert(IAttestationAccumulator.NoNewInputs.selector);
        snapshot.trigger();

        // One new edge and it mints again.
        accer.setState(bytes32(uint256(2)), 6);
        snapshot.trigger();
        assertEq(accer.checkpointCount(), 2);
    }

    /*///////////////////////////////////////////////////////////////
                            PARTIAL FUNDING
    //////////////////////////////////////////////////////////////*/

    /// The fee is settled FIRST. The other order lets a copier consume the remaining balance as
    /// gas reimbursement and leave the prover with nothing.
    function test_PartialFundingPaysTheFeeBeforeTheGas() public {
        // Enough for roughly the fee and nothing more.
        uint256 tiny = _weiFor(10 * vault.USD());
        _fund(tiny, 0);
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);

        (uint256 feeUsd, uint256 gasUsd) = _claim(id, mallory, alice);

        // The whole tank went to the fee (one wei short of exactly $10, because `_weiFor` truncates
        // — which is the vault paying what it can, not what it wishes it could).
        assertApproxEqAbs(feeUsd, 10 * vault.USD(), 1, "the fee took everything available");
        assertEq(gasUsd, 0, "and there was nothing left for the copier");
        assertEq(vault.creditOf(alice, address(0)), tiny, "every wei went to the prover");
        assertEq(vault.creditOf(mallory, address(0)), 0, "and none to the one who sent the tx");
        assertEq(vault.accountOf(INSTANCE).ethBalance, 0);
    }

    /// An empty tank does not stop the root. Correctness fails open; money fails closed.
    function test_AnEmptyTankStillLandsTheRoot() public {
        _fund(1 wei, 0);
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);

        (uint256 feeUsd,) = _claim(id, alice, alice);
        assertEq(snapshot.lastAppliedCheckpoint(), id, "the root landed");
        assertLt(feeUsd, 10 * vault.USD(), "but it paid less than the quoted fee");
    }

    /*///////////////////////////////////////////////////////////////
                        THE REJECTING RECIPIENT
    //////////////////////////////////////////////////////////////*/

    /// Money moves by pull, so a recipient that reverts on receive strands only its own money.
    function test_ARejectingRecipientCannotBlockTheRoot() public {
        RejectingRecipient hostile = new RejectingRecipient();
        _fund(10 ether, 0);
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);

        (uint256 feeUsd,) = _claim(id, alice, address(hostile));
        assertEq(snapshot.lastAppliedCheckpoint(), id, "the root landed anyway");
        assertGt(feeUsd, 0);
        assertGt(vault.creditOf(address(hostile), address(0)), 0, "the credit exists...");

        // ...and only the pull fails, which is the hostile contract's own problem.
        vm.prank(address(hostile));
        vm.expectRevert(bytes("ProvingVault: eth send failed"));
        vault.withdrawCredit(address(0), address(hostile));
    }

    /*///////////////////////////////////////////////////////////////
                    CADENCE + PER-ROOT CAP
    //////////////////////////////////////////////////////////////*/

    /// A stranger cannot drain the tank faster than the community chose.
    function test_MinPaidIntervalStopsAStrangerDrainingTheTank() public {
        _fund(10 ether, 0);
        _policy(1_000, 1_000 * vault.USD()); // pay at most once per 1000 blocks

        uint256 id0 = _mint(bytes32(uint256(1)), 5, 100);
        (uint256 fee0,) = _claim(id0, alice, alice);
        assertGt(fee0, 0);

        // A second root twenty blocks later still LANDS, it just pays nothing.
        uint256 id1 = _mint(bytes32(uint256(2)), 6, 120);
        (uint256 fee1, uint256 gas1) = _claim(id1, mallory, mallory);
        assertEq(fee1, 0);
        assertEq(gas1, 0);
        assertEq(snapshot.lastAppliedCheckpoint(), id1, "the root still landed");

        // Past the interval it pays again.
        uint256 id2 = _mint(bytes32(uint256(3)), 7, 1_200);
        (uint256 fee2,) = _claim(id2, alice, alice);
        assertGt(fee2, 0);
    }

    function test_MaxPerRootCapsTheWholeClaim() public {
        _fund(10 ether, 0);
        _policy(0, 3 * vault.USD()); // $3 ceiling against a $10 fee
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);

        (uint256 feeUsd, uint256 gasUsd) = _claim(id, alice, alice);
        assertEq(feeUsd, 3 * vault.USD(), "the fee is trimmed to the cap");
        assertEq(gasUsd, 0, "and the cap covers the WHOLE claim, so there is no room for gas");
    }

    function test_AZeroCapMeansThisInstancePaysNoBounty() public {
        _fund(10 ether, 0);
        // No policy set at all: maxPerRootUsd defaults to zero.
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);

        (uint256 feeUsd, uint256 gasUsd) = _claim(id, alice, alice);
        assertEq(feeUsd, 0);
        assertEq(gasUsd, 0);
        assertEq(snapshot.lastAppliedCheckpoint(), id, "and the root still landed");
        assertEq(vault.accountOf(INSTANCE).ethBalance, 10 ether, "nothing was spent");
    }

    /*///////////////////////////////////////////////////////////////
                            THE PRICE FEED
    //////////////////////////////////////////////////////////////*/

    function test_AStaleFeedLandsTheRootAndPaysNoFee() public {
        _fund(10 ether, 0);
        _policy(0, 1_000 * vault.USD());
        feed.set(3_000e8, block.timestamp - 2 hours); // older than FEED_MAX_STALENESS
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);

        (uint256 feeUsd, uint256 gasUsd) = _claim(id, alice, alice);
        assertEq(feeUsd, 0, "unpriced means unpaid, not guessed");
        assertEq(gasUsd, 0);
        assertEq(snapshot.lastAppliedCheckpoint(), id, "correctness fails OPEN");
    }

    function test_ANegativeOrRevertingFeedIsTreatedIdentically() public {
        _fund(10 ether, 0);
        _policy(0, 1_000 * vault.USD());

        feed.set(-1, block.timestamp);
        uint256 id0 = _mint(bytes32(uint256(1)), 5, 100);
        (uint256 f0,) = _claim(id0, alice, alice);
        assertEq(f0, 0);

        feed.set(3_000e8, block.timestamp);
        feed.setRevert(true);
        uint256 id1 = _mint(bytes32(uint256(2)), 6, 120);
        (uint256 f1,) = _claim(id1, alice, alice);
        assertEq(f1, 0);
        assertEq(snapshot.lastAppliedCheckpoint(), id1);
    }

    /*///////////////////////////////////////////////////////////////
                            FEE BANDS
    //////////////////////////////////////////////////////////////*/

    /// An unknown or oversized program prices at zero, never at the cheapest band.
    function test_AnUnknownProgramGetsZeroFeeNotTheCheapestBand() public view {
        assertEq(vault.bandOf(keccak256("not-a-program"), 1, 1), 0);
        assertEq(vault.feePerRootUsd(keccak256("not-a-program"), 0), 0);
        // Oversized falls into the same unpriced band as unknown.
        assertEq(vault.bandOf(PROGRAM, 10_000_000, 0), 0);
    }

    /// Size is the SUM of both lanes, for every program, because that is what the operator's
    /// cycle estimate sums. An earlier version banded trust-graph on `leafCount` alone: a
    /// two-lane instance with 900 edges and 400k anchors then priced at the CHEAPEST band for a
    /// proof far beyond the operator's cycle limit. Both "agreement" tests missed it because
    /// both sides only ever tested with the second lane at zero.
    function test_BothLanesCountTowardsTheBand() public view {
        assertEq(vault.bandOf(keccak256("hypercerts"), 0, 50_000), 3, "banded on the anchor log");
        assertEq(vault.bandOf(PROGRAM, 0, 50_000), 3, "a lane-1 program counts anchors too");
        assertEq(vault.bandOf(PROGRAM, 900, 400_000), 0, "and past the top band it is unpriced");
        // A lane-2-only program still has a permanently zero lane 1; the sum handles it.
        assertEq(vault.bandOf(keccak256("hypercerts"), 0, 500), 1);
    }

    /// The operator's refusal boundary and this vault's top band must be the SAME number, or we
    /// price proofs nobody will produce. `operator_core::policy::MAX_PRICED_INPUTS` carries the
    /// Rust half (`the_refusal_boundary_is_exactly_the_vaults_top_priced_band`), and it derives
    /// `cycle_limit` from it so the two cannot drift apart quietly.
    function test_TheTopBandAndTheOperatorsCycleLimitAgree() public view {
        uint64 boundary = vault.MAX_PRICED_INPUTS();
        assertEq(boundary, 200_000, "if you change this, change operator_core::MAX_PRICED_INPUTS");
        assertEq(vault.bandOf(PROGRAM, boundary, 0), 3, "the top priced band");
        assertEq(vault.bandOf(PROGRAM, boundary + 1, 0), 0, "one input past it is unpriced");
        // Every program's top band ends at the same place...
        assertEq(vault.bandOf(keccak256("hypercerts"), 0, boundary), 3);
        assertEq(vault.bandOf(keccak256("hypercerts"), 0, boundary + 1), 0);
        // ...and the boundary is on the SUM, which is what the operator's estimate sums. Without
        // this line the agreement is untested for every two-lane instance.
        assertEq(vault.bandOf(PROGRAM, boundary / 2, boundary / 2), 3);
        assertEq(vault.bandOf(PROGRAM, boundary / 2, boundary / 2 + 1), 0);
        assertEq(vault.bandOf(keccak256("contributions"), boundary, 1), 0);
    }

    /*///////////////////////////////////////////////////////////////
                                MIGRATION
    //////////////////////////////////////////////////////////////*/

    /// Binding protects a funded community from a hostile registry. It must not also strand one
    /// that legitimately migrates — anyone can bind an account with a single wei, so without an
    /// explicit migration the trap would be trivially set by a stranger.
    function test_TheCommunityCanMigrateItsTankToANewSnapshot() public {
        // A stranger binds the account first, for one wei.
        address stranger = address(0x57A);
        vm.deal(stranger, 1 wei);
        vm.prank(stranger);
        vault.depositETH{value: 1 wei}(INSTANCE);
        _fund(5 ether, 0);
        assertEq(vault.accountOf(INSTANCE).snapshot, address(snapshot));

        // The community deploys a replacement and updates the directory.
        MockAccumulator acc2 = new MockAccumulator();
        MerkleSnapshot next = new MerkleSnapshot(verifier, PARAMS, acc2, constitutional, operational);
        registry.update(
            INSTANCE,
            IInstanceRegistry.Instance({
                program: PROGRAM,
                snapshot: address(next),
                verifier: address(verifier),
                registryOrAccumulator: address(acc2),
                paramsHash: PARAMS
            })
        );
        // The update alone still redirects nothing.
        assertEq(vault.accountOf(INSTANCE).snapshot, address(snapshot));

        // A stranger cannot move it.
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(IProvingVault.NotConstitutional.selector, INSTANCE, mallory));
        vault.migrate(INSTANCE);

        // The instance's constitutional authority can, and the balance comes with it.
        vm.prank(constitutional);
        vault.migrate(INSTANCE);
        assertEq(vault.accountOf(INSTANCE).snapshot, address(next));
        assertEq(vault.accountOf(INSTANCE).ethBalance, 5 ether + 1 wei);
    }

    function test_ClaimIdsAreScopedToTheBoundSnapshotAcrossMigration() public {
        MerkleSnapshot oldSnapshot = snapshot;
        MockAccumulator oldAcc = accer;
        _fund(10 ether, 0);
        _policy(0, 1_000 * vault.USD());
        uint256 oldId = _mint(bytes32(uint256(1)), 5, 100);
        _claim(oldId, alice, alice);
        assertTrue(vault.isClaimed(INSTANCE, oldId));

        MockAccumulator acc2 = new MockAccumulator();
        MerkleSnapshot next = new MerkleSnapshot(verifier, PARAMS, acc2, constitutional, operational);
        registry.update(
            INSTANCE,
            IInstanceRegistry.Instance({
                program: PROGRAM,
                snapshot: address(next),
                verifier: address(verifier),
                registryOrAccumulator: address(acc2),
                paramsHash: PARAMS
            })
        );
        vm.prank(constitutional);
        vault.migrate(INSTANCE);

        assertFalse(vault.isClaimed(INSTANCE, oldId), "the replacement snapshot has a fresh id space");
        snapshot = next;
        accer = acc2;
        uint256 newId = _mint(bytes32(uint256(2)), 5, 200);
        assertEq(newId, oldId, "each accumulator starts checkpoint ids at zero");

        (uint256 feeUsd,) = _claim(newId, alice, alice);
        assertGt(feeUsd, 0, "the replacement snapshot's first checkpoint can be paid");
        assertTrue(vault.isClaimed(INSTANCE, newId));

        registry.update(
            INSTANCE,
            IInstanceRegistry.Instance({
                program: PROGRAM,
                snapshot: address(oldSnapshot),
                verifier: address(verifier),
                registryOrAccumulator: address(oldAcc),
                paramsHash: PARAMS
            })
        );
        vm.prank(constitutional);
        vault.migrate(INSTANCE);
        assertTrue(vault.isClaimed(INSTANCE, oldId), "migrating back remembers the original payout");
    }

    function test_MigratingToTheSameSnapshotIsRejected() public {
        _fund(1 ether, 0);
        vm.prank(constitutional);
        vm.expectRevert(
            abi.encodeWithSelector(IProvingVault.SnapshotMismatch.selector, address(snapshot), address(snapshot))
        );
        vault.migrate(INSTANCE);
    }

    function test_RequestingMoreThanTheBalanceReverts() public {
        _fund(1 ether, 0);
        vm.prank(constitutional);
        vm.expectRevert(
            abi.encodeWithSelector(IProvingVault.InsufficientBalance.selector, uint128(1 ether), uint128(0))
        );
        vault.requestWithdrawal(INSTANCE, 2 ether, 0);
    }

    /*///////////////////////////////////////////////////////////////
                            GAS REIMBURSEMENT
    //////////////////////////////////////////////////////////////*/

    /// `reimbursement <= demonstrable caller cost`, as a fuzz property.
    ///
    /// "Demonstrable" is the load-bearing word: the vault can only see the gas the forwarded call
    /// burned, priced at `block.basefee`. The caller additionally paid intrinsic gas (21k plus
    /// calldata), everything before and after the measured span, and any priority fee. So the
    /// reimbursement must be strictly below even a floor estimate of what they spent.
    function testFuzz_ReimbursementNeverExceedsDemonstrableCallerCost(uint128 basefee, uint96 balance) public {
        basefee = uint128(bound(basefee, 1, 500 gwei));
        balance = uint96(bound(balance, 0.01 ether, 50 ether));

        _fund(balance, 0);
        _policy(0, type(uint96).max); // no cap, so only the arithmetic is under test
        vm.fee(basefee);
        feed.set(3_000e8, block.timestamp);
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);

        uint256 gasBefore = gasleft();
        (, uint256 gasUsd) = _claim(id, mallory, alice);
        uint256 observedUnits = gasBefore - gasleft();

        uint256 reimbursedWei = vault.creditOf(mallory, address(0));
        // A floor on what the caller actually burned: the units this test observed around the
        // whole call (already more than the vault measured) plus the 21k intrinsic they cannot
        // avoid, at the basefee alone (ignoring any priority fee they paid).
        uint256 callerFloorWei = (observedUnits + 21_000) * basefee;
        assertLe(reimbursedWei, callerFloorWei, "the vault must never over-reimburse");
        assertLe(gasUsd, (callerFloorWei * 3_000e8) / 1e18);
    }

    /// A hook that burns gas cannot drain the tank through the reimbursement leg.
    function test_TheGasUnitCeilingBoundsTheReimbursement() public {
        _fund(10 ether, 0);
        _policy(0, type(uint96).max);
        vm.prank(feeSetter);
        vault.setGasParams(1_000, 700_000); // absurdly low ceiling

        uint256 id = _mint(bytes32(uint256(1)), 5, 100);
        _claim(id, mallory, alice);

        uint256 ceilingWei = 1_000 * block.basefee;
        assertLe(vault.creditOf(mallory, address(0)), ceilingWei);
    }

    /*///////////////////////////////////////////////////////////////
                        WITHDRAWAL NOTICE
    //////////////////////////////////////////////////////////////*/

    function test_WithdrawalNoticeCannotBeShortCircuited() public {
        _fund(5 ether, 0);
        vm.prank(constitutional);
        vault.requestWithdrawal(INSTANCE, 5 ether, 0);

        IProvingVault.PendingWithdrawal memory w = vault.pendingWithdrawalOf(INSTANCE);
        assertEq(w.ethAmount, 5 ether);
        assertEq(w.readyAt, uint64(block.timestamp) + vault.WITHDRAWAL_NOTICE());

        vm.prank(constitutional);
        vm.expectRevert(abi.encodeWithSelector(IProvingVault.WithdrawalNotReady.selector, w.readyAt));
        vault.executeWithdrawal(INSTANCE, constitutional);

        // One second early is still early.
        vm.warp(w.readyAt - 1);
        vm.prank(constitutional);
        vm.expectRevert(abi.encodeWithSelector(IProvingVault.WithdrawalNotReady.selector, w.readyAt));
        vault.executeWithdrawal(INSTANCE, constitutional);

        vm.warp(w.readyAt);
        vm.prank(constitutional);
        vault.executeWithdrawal(INSTANCE, constitutional);
        assertEq(constitutional.balance, 5 ether);
    }

    /// A pending withdrawal must NOT make the money unspendable, or the notice period is a
    /// free-roots machine: request everything, let the prover's root land unpaid, cancel.
    ///
    /// An earlier version debited on request. A community could then take every root for free —
    /// two transactions of gas, repeatable every epoch, and the checkpoint's bounty was burned
    /// permanently because `submitProof` is monotonic and can never re-apply it. Four of the eight
    /// audit agents found this independently. The money now stays at work for the whole notice
    /// period and the withdrawal takes what is LEFT.
    function test_APendingWithdrawalDoesNotStopAClaimBeingPaid() public {
        _fund(5 ether, 0);
        _policy(0, 1_000 * vault.USD());

        vm.prank(constitutional);
        vault.requestWithdrawal(INSTANCE, 5 ether, 0);
        assertEq(vault.accountOf(INSTANCE).ethBalance, 5 ether, "still spendable");

        uint256 id = _mint(bytes32(uint256(1)), 5, 100);
        (uint256 feeUsd,) = _claim(id, alice, alice);
        assertGt(feeUsd, 0, "the prover is paid during the notice period");
        assertGt(vault.creditOf(alice, address(0)), 0);
    }

    /// ...and the withdrawal then takes what is left, not what was asked for.
    function test_AWithdrawalTakesWhatIsLeftAfterBountiesWerePaid() public {
        _fund(5 ether, 0);
        _policy(0, 1_000 * vault.USD());
        vm.prank(constitutional);
        vault.requestWithdrawal(INSTANCE, 5 ether, 0);

        uint256 id = _mint(bytes32(uint256(1)), 5, 100);
        _claim(id, alice, alice);
        uint256 remaining = vault.accountOf(INSTANCE).ethBalance;
        assertLt(remaining, 5 ether, "a bounty came out of the tank");

        vm.warp(vault.pendingWithdrawalOf(INSTANCE).readyAt);
        vm.prank(constitutional);
        vault.executeWithdrawal(INSTANCE, constitutional);
        assertEq(constitutional.balance, remaining);
        assertEq(vault.accountOf(INSTANCE).ethBalance, 0);
    }

    /// The whole attack, end to end, must not work.
    function test_TheRequestCancelToggleCannotBuyAFreeRoot() public {
        _fund(5 ether, 0);
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);

        // The community front-runs the prover with a full-tank withdrawal request...
        vm.prank(constitutional);
        vault.requestWithdrawal(INSTANCE, 5 ether, 0);
        // ...the prover's claim lands anyway, and is paid...
        (uint256 feeUsd,) = _claim(id, alice, alice);
        assertGt(feeUsd, 0, "the free-roots toggle is closed");
        // ...and cancelling restores nothing, because nothing was taken away.
        uint256 balanceAfterClaim = vault.accountOf(INSTANCE).ethBalance;
        vm.prank(constitutional);
        vault.cancelWithdrawal(INSTANCE);
        assertEq(vault.accountOf(INSTANCE).ethBalance, balanceAfterClaim);
    }

    /// A second request restarts the clock; otherwise the notice period is theatre.
    function test_TopUpOfAPendingWithdrawalRestartsTheClock() public {
        _fund(5 ether, 0);
        vm.prank(constitutional);
        vault.requestWithdrawal(INSTANCE, 2 ether, 0);
        uint64 first = vault.pendingWithdrawalOf(INSTANCE).readyAt;

        vm.warp(block.timestamp + 6 days);
        vm.prank(constitutional);
        vault.requestWithdrawal(INSTANCE, 3 ether, 0);
        uint64 second = vault.pendingWithdrawalOf(INSTANCE).readyAt;
        assertGt(second, first);

        vm.warp(first);
        vm.prank(constitutional);
        vm.expectRevert(abi.encodeWithSelector(IProvingVault.WithdrawalNotReady.selector, second));
        vault.executeWithdrawal(INSTANCE, constitutional);
    }

    function test_CancellingPutsTheFundsBackToWork() public {
        _fund(5 ether, 0);
        vm.prank(constitutional);
        vault.requestWithdrawal(INSTANCE, 5 ether, 0);
        vm.prank(constitutional);
        vault.cancelWithdrawal(INSTANCE);
        assertEq(vault.accountOf(INSTANCE).ethBalance, 5 ether);
        assertEq(vault.pendingWithdrawalOf(INSTANCE).readyAt, 0);
    }

    function test_TopUpsAreInstantAndPermissionless() public {
        // Anyone may fund any instance — that is what lets the factory forward msg.value and a
        // supporter endow a community they are not a member of.
        address stranger = address(0x57A);
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vault.depositETH{value: 1 ether}(INSTANCE);
        assertEq(vault.accountOf(INSTANCE).ethBalance, 1 ether);
    }

    /*///////////////////////////////////////////////////////////////
                                AUTHORITY
    //////////////////////////////////////////////////////////////*/

    /// Constitutional, not operational. Operational is the short-lane params role; extending it
    /// to fund custody widens it into something it was not designed to be.
    function test_OnlyConstitutionalGovernsTheTank() public {
        _fund(1 ether, 0);

        for (uint256 i = 0; i < 3; i++) {
            address who = i == 0 ? operational : (i == 1 ? admin : mallory);
            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(IProvingVault.NotConstitutional.selector, INSTANCE, who));
            vault.setPolicy(INSTANCE, 0, 1);

            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(IProvingVault.NotConstitutional.selector, INSTANCE, who));
            vault.requestWithdrawal(INSTANCE, 1 ether, 0);
        }

        vm.prank(constitutional);
        vault.setPolicy(INSTANCE, 0, 1);
        assertEq(vault.policyOf(INSTANCE).maxPerRootUsd, 1);
    }

    function test_OnlyTheFeeSetterSetsPrices() public {
        vm.prank(mallory);
        vm.expectRevert();
        vault.setFeePerRootUsd(PROGRAM, 1, 1);

        vm.prank(constitutional);
        vm.expectRevert();
        vault.setGasParams(1, 1);

        vm.prank(feeSetter);
        vault.setFeePerRootUsd(PROGRAM, 1, 42);
        assertEq(vault.feePerRootUsd(PROGRAM, 1), 42);
    }

    /*///////////////////////////////////////////////////////////////
                            REENTRANCY
    //////////////////////////////////////////////////////////////*/

    function test_ReentrancyThroughTheCreditWithdrawalCannotDoubleClaim() public {
        ReentrantRecipient hostile = new ReentrantRecipient();
        _fund(10 ether, 0);
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);

        _claim(id, alice, address(hostile));
        uint256 credited = vault.creditOf(address(hostile), address(0));
        assertGt(credited, 0);

        // Re-entering `submitAndClaim` from `receive()` must not pay twice.
        hostile.arm(vault, INSTANCE, _args(id, address(hostile)));
        hostile.pull();
        assertEq(vault.creditOf(address(hostile), address(0)), 0, "credit paid out exactly once");
        assertTrue(vault.isClaimed(INSTANCE, id));
    }

    function test_WithdrawingNothingReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IProvingVault.NoCredit.selector, alice, address(0)));
        vault.withdrawCredit(address(0), alice);
    }

    /*///////////////////////////////////////////////////////////////
                                USDC
    //////////////////////////////////////////////////////////////*/

    function test_EthIsDrawnBeforeUsdc() public {
        uint256 halfFee = _weiFor(5 * vault.USD());
        _fund(halfFee, 100e6); // half the fee in ETH, $100 in USDC
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);

        _claim(id, alice, alice);
        assertEq(vault.accountOf(INSTANCE).ethBalance, 0, "ETH is exhausted first");
        assertEq(vault.creditOf(alice, address(0)), halfFee);
        assertGt(vault.creditOf(alice, address(usdc)), 0, "the remainder came from USDC");
        assertLt(vault.accountOf(INSTANCE).usdcBalance, 100e6);
    }

    function test_UsdcCreditWithdrawsAsUsdc() public {
        _fund(0, 100e6);
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);
        _claim(id, alice, alice);

        uint256 credit = vault.creditOf(alice, address(usdc));
        assertGt(credit, 0);
        vm.prank(alice);
        vault.withdrawCredit(address(usdc), alice);
        assertEq(usdc.balanceOf(alice), credit);
        assertEq(vault.creditOf(alice, address(usdc)), 0);
    }

    /*///////////////////////////////////////////////////////////////
                                QUOTE
    //////////////////////////////////////////////////////////////*/

    /// The operator calls this BEFORE proving. Discovering mid-flight that a proof will not be
    /// paid for is the failure it exists to prevent.
    function test_QuoteReportsEveryIneligibilityBeforeAnyProvingHappens() public {
        // No account.
        IProvingVault.Quote memory q = vault.quote(keccak256("nope"), 0);
        assertFalse(q.eligible);
        assertEq(q.reason, uint8(IProvingVault.IneligibleReason.NoAccount));

        // No policy.
        _fund(10 ether, 0);
        q = vault.quote(INSTANCE, 0);
        assertEq(q.reason, uint8(IProvingVault.IneligibleReason.PolicyDisabled));

        // Funded and priced.
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);
        q = vault.quote(INSTANCE, id);
        assertTrue(q.eligible);
        assertEq(q.reason, uint8(IProvingVault.IneligibleReason.None));
        assertEq(q.feeUsd, 10 * vault.USD());
        assertGt(q.payableUsd, 0);

        // Cadence.
        _claim(id, alice, alice);
        _policy(1_000, 1_000 * vault.USD());
        uint256 nextId = _mint(bytes32(uint256(2)), 5, 200);
        q = vault.quote(INSTANCE, nextId);
        assertFalse(q.eligible);
        assertEq(q.reason, uint8(IProvingVault.IneligibleReason.CadenceNotElapsed));
    }

    function test_QuoteReportsInsufficientBalance() public {
        _fund(1 wei, 0);
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);
        IProvingVault.Quote memory q = vault.quote(INSTANCE, id);
        assertFalse(q.eligible);
        assertEq(q.reason, uint8(IProvingVault.IneligibleReason.InsufficientBalance));
    }

    function test_QuoteReportsAlreadyClaimedCheckpoint() public {
        _fund(10 ether, 0);
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);
        _claim(id, alice, alice);

        IProvingVault.Quote memory q = vault.quote(INSTANCE, id);
        assertFalse(q.eligible);
        assertEq(q.reason, uint8(IProvingVault.IneligibleReason.AlreadyClaimed));
    }

    function test_UnknownProgramIsIneligibleInQuoteAndSettlement() public {
        bytes32 unknown = keccak256("unknown-program");
        registry.update(
            INSTANCE,
            IInstanceRegistry.Instance({
                program: unknown,
                snapshot: address(snapshot),
                verifier: address(verifier),
                registryOrAccumulator: address(accer),
                paramsHash: PARAMS
            })
        );
        _fund(10 ether, 0);
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);

        IProvingVault.Quote memory q = vault.quote(INSTANCE, id);
        assertFalse(q.eligible);
        assertEq(q.reason, uint8(IProvingVault.IneligibleReason.UnknownProgram));
        assertEq(q.feeUsd, 0);
        assertEq(q.gasUsd, 0);

        vm.expectEmit(true, true, false, true, address(vault));
        emit IProvingVault.ClaimSkipped(INSTANCE, id, uint8(IProvingVault.IneligibleReason.UnknownProgram));
        (uint256 feeUsd, uint256 gasUsd) = _claim(id, alice, alice);
        assertEq(feeUsd, 0);
        assertEq(gasUsd, 0);
        assertEq(snapshot.lastAppliedCheckpoint(), id, "an unpriced root still lands");
    }

    function test_FeedOutageIsReportedAsTransientInQuoteAndSettlement() public {
        _fund(10 ether, 0);
        _policy(0, 1_000 * vault.USD());
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);
        feed.set(3_000e8, block.timestamp - 2 hours);

        IProvingVault.Quote memory q = vault.quote(INSTANCE, id);
        assertFalse(q.eligible);
        assertEq(q.reason, uint8(IProvingVault.IneligibleReason.PriceFeedUnavailable));

        vm.expectEmit(true, true, false, true, address(vault));
        emit IProvingVault.ClaimSkipped(INSTANCE, id, uint8(IProvingVault.IneligibleReason.PriceFeedUnavailable));
        (uint256 feeUsd, uint256 gasUsd) = _claim(id, alice, alice);
        assertEq(feeUsd, 0);
        assertEq(gasUsd, 0);
        assertFalse(vault.isClaimed(INSTANCE, id), "a transient outage does not consume the bounty");
    }

    /// A pending withdrawal is deliberately NOT an ineligibility. Making it one was how an
    /// earlier version handed the community a free-roots switch; the balance check is what
    /// actually describes whether a claim can be paid.
    function test_APendingWithdrawalDoesNotMakeAQuoteIneligible() public {
        _fund(10 ether, 0);
        _policy(0, 1_000 * vault.USD());
        vm.prank(constitutional);
        vault.requestWithdrawal(INSTANCE, 1 ether, 0);
        uint256 id = _mint(bytes32(uint256(1)), 5, 100);
        IProvingVault.Quote memory q = vault.quote(INSTANCE, id);
        assertTrue(q.eligible, "the money is still there and still spendable");
    }
}
