// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IProvingVault} from "interfaces/vault/IProvingVault.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IEthUsdFeed} from "interfaces/vault/IEthUsdFeed.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {IMerkleSnapshot} from "interfaces/merkle/IMerkleSnapshot.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {InputCapacity} from "src/limits/InputCapacity.sol";

/// @title ProvingVault
/// @notice A per-instance tank a community tops up so somebody keeps proving its scores.
/// @dev The contract-level rationale lives on `IProvingVault`. This file is the arithmetic, and
///      four numbers in it are load-bearing:
///
///      1. **Fee before gas.** Under partial funding the fee is settled first, or a copier could
///         consume the remaining balance as gas reimbursement and leave the prover with nothing.
///      2. **`reimbursement <= demonstrable caller cost`, including refunds.** EIP-3529 can refund
///         at most 20% of a transaction's gross gas, so only 80% of the measured span is eligible.
///         That span excludes intrinsic gas and everything after it, and is priced at
///         `block.basefee`, no more than the caller's effective gas price. Trying to reimburse the
///         full measured span would overpay a hook that clears storage inside it.
///      3. **Fail open on correctness, closed on money.** A stale or unusable price feed pays a
///         zero proving fee and still lands the root. A root that cannot be paid for is still a
///         root; a payment we cannot price is not a payment we should guess at.
///      4. **Unknown program ⇒ zero fee, never the cheapest band.** The band function is
///         per-program because a lane-2-only program's `leafCount` is permanently zero, and a
///         shared leafCount-derived band would price it as the smallest possible graph.
contract ProvingVault is IProvingVault, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Sets the fee schedule and the global gas ceiling. Us, in v1 (§8.2). Moving it
    ///         behind the operational timelock is a recorded open question, not a shipped feature.
    bytes32 public constant FEE_SETTER_ROLE = keccak256("FEE_SETTER_ROLE");

    /// @notice USD fixed-point scale (matches Chainlink's 8-decimal USD feeds).
    uint256 public constant USD = 1e8;

    /// @notice Circle USDC's decimal precision, which every stablecoin conversion below assumes.
    uint8 internal constant USDC_DECIMALS = 6;

    /// @notice Circle USDC's decimal scale, derived from the asserted precision.
    uint256 internal constant USDC_SCALE = 1e6;

    /// @notice The stablecoin does not use the six-decimal scale required by the vault's math.
    error StablecoinDecimalsUnsupported(uint8 decimals);

    /// @notice Notice period before a withdrawal can be executed. Instant withdrawal would let a
    ///         community rug a prover mid-proof, which is exactly the reliability the hosted
    ///         service sells. Top-ups stay instant.
    uint64 public constant WITHDRAWAL_NOTICE = 7 days;

    /// @notice The ETH the sentinel `token` argument refers to.
    address public constant ETH = address(0);

    /// @notice Hard ceiling on reimbursable gas units for one claim, whatever the measurement says.
    /// @dev `MerkleSnapshot._updateStateAtBlock` calls arbitrary hooks, so the forwarded call's gas
    ///      is not bounded by anything this contract controls. Without a unit cap, an instance
    ///      whose own hook burns gas could drain its own tank through the reimbursement leg. Unit-
    ///      denominated on purpose: it holds even when the price feed does not.
    uint256 public maxGasUnitsPerClaim = 1_500_000;

    /// @notice What `quote()` assumes a claim will cost, since a view cannot measure.
    uint256 public nominalGasUnits = 700_000;

    /// @dev EIP-3529 caps refunds at `gas_used / 5`. Reimbursing at most the complementary 4/5 of
    ///      our narrower measured span keeps the gas leg below the caller's post-refund cost.
    uint256 internal constant REFUND_SAFE_NUMERATOR = 4;
    uint256 internal constant REFUND_SAFE_DENOMINATOR = 5;

    /// @notice The protocol's largest priced proof-input count (edges plus authenticated anchors).
    /// @dev This is a payment/ingress ceiling, not a promise that one operator host can prove every
    ///      priced checkpoint. Operator capability and cycle envelopes are configurable local
    ///      policy and may refuse much earlier; another prover can still accept the checkpoint.
    ///      Solidity and Rust hand-written asserts pin only this 200,000 protocol value.
    uint64 public constant MAX_PRICED_INPUTS = InputCapacity.MAX_TOTAL_INPUTS;

    IInstanceRegistry public immutable REGISTRY;
    IERC20 public immutable USDC;
    IEthUsdFeed public immutable ETH_USD_FEED;
    /// @notice Older than this and the feed is unusable: zero fee, root still lands.
    uint64 public immutable FEED_MAX_STALENESS;
    /// @notice Answers outside `[MIN_ETH_USD, MAX_ETH_USD]` are treated as no answer at all.
    ///         Without a floor, a crashed or misconfigured aggregator turns the per-root USD cap
    ///         into no cap at all on the ETH leg.
    uint256 public immutable MIN_ETH_USD;
    uint256 public immutable MAX_ETH_USD;

    mapping(bytes32 instanceId => Account) internal _accounts;
    mapping(bytes32 instanceId => Policy) internal _policies;
    mapping(bytes32 instanceId => PendingWithdrawal) internal _pending;
    mapping(bytes32 instanceId => mapping(address snapshot => mapping(uint256 checkpointId => bool))) internal _claimed;
    /// @notice Proven statements already paid for, so two checkpoints carrying the SAME proof
    ///         cannot each collect. `MerkleSnapshot.trigger()` rejects an adjacent no-movement
    ///         checkpoint; this also catches a commitment that recurs after an intervening state.
    mapping(bytes32 instanceId => mapping(bytes32 statement => bool)) internal _paidStatement;
    mapping(address account => mapping(address token => uint256)) internal _credit;

    /// @inheritdoc IProvingVault
    mapping(bytes32 program => mapping(uint8 band => uint256)) public feePerRootUsd;

    /// @notice Emitted when the gas ceiling or the nominal quote changes.
    event GasParamsUpdated(uint256 maxGasUnitsPerClaim, uint256 nominalGasUnits);

    constructor(
        IInstanceRegistry registry,
        IERC20 usdc,
        IEthUsdFeed feed,
        uint64 feedMaxStaleness,
        uint256 minEthUsd,
        uint256 maxEthUsd,
        address feeSetter,
        address admin
    ) {
        if (
            address(registry) == address(0) || address(usdc) == address(0) || address(feed) == address(0)
                || feeSetter == address(0) || admin == address(0) || feedMaxStaleness == 0 || minEthUsd == 0
                || maxEthUsd <= minEthUsd
        ) revert ZeroAmount();
        // Every conversion in this file assumes an 8-decimal feed and a 6-decimal stablecoin.
        // Assert both once here rather than discovering a mismatched deployment through a silent
        // underpayment, overpayment, or incorrect solvency quote.
        uint8 feedDecimals = feed.decimals();
        if (feedDecimals != 8) revert FeedDecimalsUnsupported(feedDecimals);
        uint8 stablecoinDecimals = IERC20Metadata(address(usdc)).decimals();
        if (stablecoinDecimals != USDC_DECIMALS) revert StablecoinDecimalsUnsupported(stablecoinDecimals);
        REGISTRY = registry;
        USDC = usdc;
        ETH_USD_FEED = feed;
        FEED_MAX_STALENESS = feedMaxStaleness;
        MIN_ETH_USD = minEthUsd;
        MAX_ETH_USD = maxEthUsd;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FEE_SETTER_ROLE, feeSetter);
    }

    /*///////////////////////////////////////////////////////////////
                                FUNDING
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IProvingVault
    function depositETH(bytes32 instanceId) external payable {
        if (msg.value == 0 || msg.value > type(uint128).max) revert ZeroAmount();
        _bind(instanceId);
        _accounts[instanceId].ethBalance += uint128(msg.value);
        emit Deposited(instanceId, ETH, msg.sender, msg.value);
    }

    /// @inheritdoc IProvingVault
    function depositUSDC(bytes32 instanceId, uint256 amount) external {
        if (amount == 0 || amount > type(uint128).max) revert ZeroAmount();
        _bind(instanceId);
        // Credit the measured delta, not the requested amount: USDC is upgradeable and already
        // ships a blacklist, and a deployment against a fee-charging 6dp token would otherwise
        // book more than the vault holds and strand the last withdrawer.
        uint256 before = USDC.balanceOf(address(this));
        USDC.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = USDC.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
        _accounts[instanceId].usdcBalance += uint128(received);
        emit Deposited(instanceId, address(USDC), msg.sender, received);
    }

    /// Resolve the registry EXACTLY ONCE, at first deposit. Re-resolving per claim would let the
    /// registry's `OPERATOR_ROLE` point a funded community's balance at a snapshot of its choosing;
    /// binding makes migration an explicit, community-authorized action instead.
    function _bind(bytes32 instanceId) internal {
        Account storage a = _accounts[instanceId];
        if (a.snapshot != address(0)) return;

        IInstanceRegistry.Instance memory record = REGISTRY.getInstance(instanceId);
        if (record.snapshot == address(0)) revert UnknownInstance(instanceId);
        a.snapshot = record.snapshot;
        a.program = record.program;
        emit AccountBound(instanceId, record.snapshot, record.program);
    }

    /// @notice Re-resolve this account's snapshot from the registry. The explicit,
    ///         community-authorized migration the bind-at-first-deposit rule implies.
    /// @dev Without this the binding is a trap rather than a protection: anyone can bind an
    ///      account with one wei, so a community that later migrates its instance would find its
    ///      tank permanently pointed at the old snapshot with no way to move it. Gated on the
    ///      CURRENTLY bound snapshot's constitutional role, so the people moving the money are the
    ///      ones who control the instance it is bound to today — a registry update alone still
    ///      cannot redirect anything.
    function migrate(bytes32 instanceId) external nonReentrant onlyConstitutional(instanceId) {
        Account storage a = _accounts[instanceId];
        IInstanceRegistry.Instance memory record = REGISTRY.getInstance(instanceId);
        if (record.snapshot == address(0)) revert UnknownInstance(instanceId);
        // Either field may be the one that moved. Refusing when only the PROGRAM changed left
        // `a.program` stale forever, and a stale label bands at zero — a funded tank that can
        // never pay a fee again, with no recovery short of a 7-day withdrawal.
        if (record.snapshot == a.snapshot && record.program == a.program) {
            revert SnapshotMismatch(a.snapshot, record.snapshot);
        }
        a.snapshot = record.snapshot;
        a.program = record.program;
        emit AccountBound(instanceId, record.snapshot, record.program);
    }

    /*///////////////////////////////////////////////////////////////
                            SUBMIT + CLAIM
    //////////////////////////////////////////////////////////////*/

    /// Everything the payout is priced from, read BEFORE control leaves this contract.
    /// @dev `MerkleSnapshot._updateStateAtBlock` calls community-installed hooks inside the
    ///      forwarded `submitProof`. Reading policy, program or size after that call would let a
    ///      hook rewrite the price of the claim from inside the prover's own transaction — no
    ///      mempool race required, and a private relay no defence. So the terms are fixed first
    ///      and settled against the copy.
    struct Terms {
        address snapshot;
        bytes32 program;
        uint96 maxPerRootUsd;
        uint64 minPaidIntervalBlocks;
        uint64 lastPaidBlock;
        uint64 leafCount;
        uint64 anchorCount;
        bool sizeKnown;
        bytes32 statement;
    }

    /// @inheritdoc IProvingVault
    function submitAndClaim(bytes32 instanceId, SubmitArgs calldata args)
        external
        nonReentrant
        returns (uint256 feeUsd, uint256 gasUsd)
    {
        Account storage a = _accounts[instanceId];
        if (a.snapshot == address(0)) revert UnknownInstance(instanceId);
        _requireUnclaimed(instanceId, a.snapshot, args.checkpointId);

        Terms memory t = _terms(instanceId, a, args.checkpointId, args.outputRoot);

        // Measure only the forwarded call. Deliberately excludes this function's own prologue, the
        // transaction's intrinsic gas, and everything after — every omission under-pays.
        MerkleSnapshot snapshot = MerkleSnapshot(t.snapshot);
        uint256 gasBefore = gasleft();
        snapshot.submitProof(
            args.checkpointId,
            args.outputRoot,
            args.ipfsHash,
            args.ipfsHashCid,
            args.totalValue,
            args.skippedDigest,
            args.recipient,
            args.proof
        );
        uint256 gasUsed = gasBefore - gasleft();

        if (!snapshot.hasAppliedCheckpoint() || snapshot.lastAppliedCheckpoint() != args.checkpointId) {
            revert CheckpointNotApplied(args.checkpointId, snapshot.lastAppliedCheckpoint());
        }

        (feeUsd, gasUsd) = _settle(instanceId, a, t, args.checkpointId, args.recipient, gasUsed, args.minPayoutUsd);
    }

    /// @inheritdoc IProvingVault
    /// @dev The other half of "the bounty cannot be stolen". Pays no gas leg: whoever calls this
    ///      did not submit the root, and the account that did is not identifiable from here.
    function claim(bytes32 instanceId, uint256 checkpointId) external nonReentrant returns (uint256 feeUsd) {
        Account storage a = _accounts[instanceId];
        if (a.snapshot == address(0)) revert UnknownInstance(instanceId);
        _requireUnclaimed(instanceId, a.snapshot, checkpointId);

        MerkleSnapshot snapshot = MerkleSnapshot(a.snapshot);
        if (!snapshot.hasAppliedCheckpoint() || snapshot.lastAppliedCheckpoint() < checkpointId) {
            revert CheckpointNotApplied2(checkpointId);
        }
        address recipient = snapshot.checkpointRecipient(checkpointId);
        if (recipient == address(0)) revert CheckpointNotApplied2(checkpointId);

        // Read the state accepted for THIS checkpoint. The latest state may belong to a newer
        // checkpoint, and combining its root with this checkpoint's input commitment would burn
        // the newer checkpoint's bounty when an older root is claimed first.
        (IMerkleSnapshot.MerkleState memory acceptedState,) = snapshot.getAcceptedCheckpoint(checkpointId);
        Terms memory t = _terms(instanceId, a, checkpointId, acceptedState.root);
        (feeUsd,) = _settle(instanceId, a, t, checkpointId, recipient, 0, 0);
    }

    function _requireUnclaimed(bytes32 instanceId, address snapshot, uint256 checkpointId) internal view {
        if (_claimed[instanceId][snapshot][checkpointId]) revert AlreadyClaimed(instanceId, checkpointId);
    }

    /// Freeze the terms of the claim.
    function _terms(bytes32 instanceId, Account storage a, uint256 checkpointId, bytes32 outputRoot)
        internal
        view
        returns (Terms memory t)
    {
        Policy storage p = _policies[instanceId];
        t.snapshot = a.snapshot;
        t.program = a.program;
        t.maxPerRootUsd = p.maxPerRootUsd;
        t.minPaidIntervalBlocks = p.minPaidIntervalBlocks;
        t.lastPaidBlock = p.lastPaidBlock;
        bytes32 checkpointAcc;
        (checkpointAcc, t.leafCount, t.anchorCount, t.sizeKnown) = _sizeOf(a.snapshot, checkpointId);
        // What was actually proven, independent of which checkpoint id carried it. The input
        // accumulator is part of the journal and therefore part of proof identity. Counts plus
        // output root alone collide on compose checkpoints whose source count and allocation are
        // unchanged even though each checkpoint has a distinct accumulator and requires a
        // distinct proof.
        t.statement = keccak256(abi.encode(t.snapshot, checkpointAcc, t.leafCount, t.anchorCount, outputRoot));
    }

    /// The money.
    function _settle(
        bytes32 instanceId,
        Account storage a,
        Terms memory t,
        uint256 checkpointId,
        address recipient,
        uint256 gasUsed,
        uint256 minPayoutUsd
    ) internal returns (uint256 feeUsd, uint256 gasUsd) {
        if (t.maxPerRootUsd == 0) {
            _skip(instanceId, checkpointId, IneligibleReason.PolicyDisabled, minPayoutUsd);
            return (0, 0);
        }
        if (t.lastPaidBlock != 0 && block.number < uint256(t.lastPaidBlock) + t.minPaidIntervalBlocks) {
            _skip(instanceId, checkpointId, IneligibleReason.CadenceNotElapsed, minPayoutUsd);
            return (0, 0);
        }

        uint8 band = bandOf(t.program, t.leafCount, t.anchorCount);
        if (!t.sizeKnown || band == 0) {
            _skip(instanceId, checkpointId, IneligibleReason.UnknownProgram, minPayoutUsd);
            return (0, 0);
        }

        // A payment refusal must not unwind a proof that `submitProof` already verified and
        // accepted. Treat a previously paid statement like every other ineligible settlement:
        // skip its payout (or honor the caller's explicit nonzero minimum-payout guard).
        if (_paidStatement[instanceId][t.statement]) {
            _skip(instanceId, checkpointId, IneligibleReason.AlreadyClaimed, minPayoutUsd);
            return (0, 0);
        }

        uint256 cap = t.maxPerRootUsd;
        (uint256 ethUsdPrice, bool feedOk) = _ethUsd();
        if (!feedOk) {
            _skip(instanceId, checkpointId, IneligibleReason.PriceFeedUnavailable, minPayoutUsd);
            return (0, 0);
        }

        // --- the proving fee ----------------------------------------------------------------
        feeUsd = feePerRootUsd[t.program][band];
        if (feeUsd > cap) feeUsd = cap;

        // --- the gas reimbursement ------------------------------------------------------------
        uint256 units = _refundSafeGasUnits(_min(gasUsed, maxGasUnitsPerClaim));
        if (units != 0) {
            gasUsd = _gasUsd(units, ethUsdPrice);
            uint256 room = cap > feeUsd ? cap - feeUsd : 0;
            if (gasUsd > room) gasUsd = room;
        }

        // The prover's own guard, checked BEFORE anything is spent or marked. A community that
        // zeroed its policy, drained its own tank, or let the feed go stale now gets a reverted
        // transaction rather than a free root.
        uint256 offered = _min(feeUsd + gasUsd, _payableUsd(a, ethUsdPrice, feedOk));
        if (offered < minPayoutUsd) revert PayoutBelowMinimum(offered, minPayoutUsd);

        uint256 ethSpent;
        uint256 usdcSpent;
        (feeUsd, ethSpent, usdcSpent) = _pay(a, recipient, feeUsd, ethUsdPrice);
        (uint256 gasPaid, uint256 e2, uint256 u2) = _pay(a, msg.sender, gasUsd, ethUsdPrice);
        gasUsd = gasPaid;
        ethSpent += e2;
        usdcSpent += u2;

        // A checkpoint's one-shot bounty slot is consumed only when it actually paid. Marking it
        // regardless made every transient failure — a missed oracle heartbeat, a briefly empty
        // tank — permanently destroy that root's bounty with no retry.
        if (ethSpent != 0 || usdcSpent != 0) {
            _claimed[instanceId][t.snapshot][checkpointId] = true;
            _paidStatement[instanceId][t.statement] = true;
            _policies[instanceId].lastPaidBlock = uint64(block.number);
            emit Claimed(instanceId, checkpointId, recipient, msg.sender, feeUsd, gasUsd, ethSpent, usdcSpent);
        } else {
            _skip(instanceId, checkpointId, IneligibleReason.InsufficientBalance, minPayoutUsd);
        }
    }

    function _skip(bytes32 instanceId, uint256 checkpointId, IneligibleReason reason, uint256 minPayoutUsd) internal {
        // A prover that asked to be paid gets a revert, not a shrug.
        if (minPayoutUsd != 0) revert PayoutBelowMinimum(0, minPayoutUsd);
        emit ClaimSkipped(instanceId, checkpointId, uint8(reason));
    }

    /// The one gas-USD formula, shared by `_settle` and `quote` so the pre-flight quote and the
    /// settlement can never round apart and trip the operator's own minimum-payout guard.
    function _gasUsd(uint256 units, uint256 ethUsdPrice) internal view returns (uint256) {
        return (units * block.basefee * ethUsdPrice) / 1e18;
    }

    /// Credit `usdAmount` to `to`, ETH first then USDC, returning what was actually paid.
    function _pay(Account storage a, address to, uint256 usdAmount, uint256 ethUsdPrice)
        internal
        returns (uint256 paidUsd, uint256 ethSpent, uint256 usdcSpent)
    {
        if (usdAmount == 0 || to == address(0)) return (0, 0, 0);

        if (a.ethBalance != 0) {
            uint256 wantWei = (usdAmount * 1e18) / ethUsdPrice;
            uint256 payWei = wantWei > a.ethBalance ? a.ethBalance : wantWei;
            if (payWei != 0) {
                a.ethBalance -= uint128(payWei);
                _credit[to][ETH] += payWei;
                ethSpent = payWei;
                uint256 coveredUsd = (payWei * ethUsdPrice) / 1e18;
                paidUsd += coveredUsd;
                usdAmount = usdAmount > coveredUsd ? usdAmount - coveredUsd : 0;
                emit CreditAccrued(to, ETH, payWei);
            }
        }

        if (usdAmount != 0 && a.usdcBalance != 0) {
            uint256 wantUsdc = (usdAmount * USDC_SCALE) / USD;
            uint256 payUsdc = wantUsdc > a.usdcBalance ? a.usdcBalance : wantUsdc;
            if (payUsdc != 0) {
                a.usdcBalance -= uint128(payUsdc);
                _credit[to][address(USDC)] += payUsdc;
                usdcSpent = payUsdc;
                paidUsd += (payUsdc * USD) / USDC_SCALE;
                emit CreditAccrued(to, address(USDC), payUsdc);
            }
        }
    }

    /// The identity and size a checkpoint froze, and whether we actually know them.
    /// @dev The flag is the whole point: a failed read must surface, not default to zero and leave
    ///      `leafCount = 0`, which `bandOf` maps to band 1 — the CHEAPEST PRICED band, the exact
    ///      opposite of the "unknown ⇒ unpriced" rule this file claims to follow. Now a failed
    ///      read pays no fee at all.
    function _sizeOf(address snapshotAddr, uint256 checkpointId)
        internal
        view
        returns (bytes32 checkpointAcc, uint64 leafCount, uint64 anchorCount, bool known)
    {
        MerkleSnapshot snapshot = MerkleSnapshot(snapshotAddr);
        try snapshot.accumulator() returns (IAttestationAccumulator acc) {
            try acc.getCheckpoint(checkpointId) returns (IAttestationAccumulator.Checkpoint memory c) {
                checkpointAcc = c.acc;
                leafCount = c.leafCount;
                known = true;
            } catch {
                return (0, 0, 0, false);
            }
        } catch {
            return (0, 0, 0, false);
        }
        try snapshot.anchorCheckpoints(checkpointId) returns (bytes32, uint64 ac) {
            anchorCount = ac;
        } catch {
            return (0, 0, 0, false);
        }
        // Work-aware snapshots checkpoint the authenticated lane-2 cost separately while keeping
        // the journal's raw anchorCount unchanged. The catch is NOT back-compatibility: an account
        // binds to whatever `snapshot` the registry names, and `OPERATOR_ROLE` can register a row
        // pointing at a contract that is not a MerkleSnapshot at all. A missing, malformed, or
        // undersized answer falls back to the raw anchor count, which can only overprice.
        try snapshot.checkpointWorkCount(checkpointId) returns (uint64 work) {
            if (work >= anchorCount) anchorCount = work;
        } catch {}
    }

    function _min(uint256 x, uint256 y) internal pure returns (uint256) {
        return x < y ? x : y;
    }

    function _refundSafeGasUnits(uint256 grossUnits) internal pure returns (uint256) {
        return (grossUnits * REFUND_SAFE_NUMERATOR) / REFUND_SAFE_DENOMINATOR;
    }

    /*///////////////////////////////////////////////////////////////
                                PRICING
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IProvingVault
    /// @dev Per program, and defaulting to a band whose fee is zero for anything unrecognised.
    ///      Band 0 is reserved as the "we do not price this" band and is never set.
    function bandOf(bytes32 program, uint64 leafCount, uint64 anchorCount) public pure returns (uint8) {
        // Size is the SUM of both lanes, for every program, because that is exactly what the
        // operator's cycle estimate sums (`InstanceSize::estimated_cycles`). Any other size rule
        // (`max`, or one lane alone) makes the shared `MAX_PRICED_INPUTS` boundary disagree with
        // the operator's admission check for two-lane instances — priced here, refused there —
        // and lets a small-edge, huge-anchor instance price at the cheapest band for a proof far
        // past the operator's limit.
        //
        // Keeping a per-program `if` even though the arithmetic is now shared is deliberate: an
        // unrecognised program must fall through to the unpriced band, not inherit a default.
        uint256 n = uint256(leafCount) + anchorCount;
        // `trust-graph-weighted` is sized like trust-graph: its guest proves the same fixed-point
        // PageRank over the same accumulator-committed edge log, plus a prior manifest whose size
        // is bounded at creation — so the on-chain counters ARE the work, unlike the flat-banded
        // programs below. Without this arm the program answered 0 (unpriced) and every
        // governed-weighted prepay path was dead on arrival (research/DEVIATIONS.md).
        if (
            program == keccak256("trust-graph") || program == keccak256("trust-graph-weighted")
                || program == keccak256("signer-sync") || program == keccak256("contributions")
                || program == keccak256("hypercerts")
        ) {
            if (n <= 1_000) return 1;
            if (n <= 20_000) return 2;
            if (n <= MAX_PRICED_INPUTS) return 3;
            return 0; // beyond the top band = beyond the operator's cycle limit = unpriced
        }
        // Composition and Nostr both hide authenticated work behind small on-chain counters:
        // 2–8 source captures for composition, and one community anchor for an Option-A audit
        // prefix that may contain thousands of entries/signatures. Their operators perform exact
        // byte/account/signature/work-cap eligibility before proving; the vault conservatively
        // reserves the top supported fee instead of pretending the visible counter is the work.
        if (program == keccak256("trust-compose") || program == keccak256("nostr-workspace")) return 3;
        // Unknown program. Zero, never the cheapest band.
        return 0;
    }

    /// @inheritdoc IProvingVault
    function setFeePerRootUsd(bytes32 program, uint8 band, uint256 usdPerRoot) external onlyRole(FEE_SETTER_ROLE) {
        // Band 0 means "we do not price this": an unknown program, an oversized instance, or a
        // size read that failed. Letting it carry a price would quietly turn every one of those
        // into a paid claim, which is the exact opposite of "unknown ⇒ zero fee, never the
        // cheapest band".
        if (band == 0) revert UnpricedBandIsReserved();
        feePerRootUsd[program][band] = usdPerRoot;
        emit FeeScheduleUpdated(program, band, usdPerRoot);
    }

    /// @notice Set the reimbursable-gas ceiling and the nominal quote.
    function setGasParams(uint256 maxUnits, uint256 nominalUnits) external onlyRole(FEE_SETTER_ROLE) {
        // Bounded so no setting can make `quote()` or a claim overflow. 30M is a full block.
        if (maxUnits > 30_000_000 || nominalUnits > 30_000_000) revert ZeroAmount();
        maxGasUnitsPerClaim = maxUnits;
        nominalGasUnits = nominalUnits;
        emit GasParamsUpdated(maxUnits, nominalUnits);
    }

    /// The ETH/USD price, and whether it is usable at all.
    /// @dev Three things here are load-bearing and each was wrong once.
    ///
    ///      1. The staleness comparison is written so it cannot underflow. `block.timestamp -
    ///         updatedAt` sits in the SUCCESS branch of a `try`, which `catch` does not cover, so
    ///         a feed reporting a future `updatedAt` (clock skew, an L2 sequencer wrapper) would
    ///         panic and revert the whole claim — turning "fail open on correctness" into a hard
    ///         denial of root submission.
    ///      2. The answer is bounded. `maxPerRootUsd` is denominated in oracle-USD while the ETH
    ///         leg converts at the same oracle, so a low-but-fresh price does not cap anything: at
    ///         $1/ETH a $50 claim withdraws 50 ETH. An out-of-band answer is no answer.
    ///      3. Everything downstream assumes 8 decimals, so the constructor asserts it rather than
    ///         trusting the deployment. An 18-decimal feed would underpay a prover by 1e10.
    function _ethUsd() internal view returns (uint256 price, bool ok) {
        try ETH_USD_FEED.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0) return (0, false);
            uint256 p = uint256(answer);
            if (p < MIN_ETH_USD || p > MAX_ETH_USD) return (0, false);
            if (updatedAt == 0 || updatedAt > block.timestamp) return (0, false);
            if (block.timestamp - updatedAt > FEED_MAX_STALENESS) return (0, false);
            return (p, true);
        } catch {
            return (0, false);
        }
    }

    /*///////////////////////////////////////////////////////////////
                            COMMUNITY CONTROLS
    //////////////////////////////////////////////////////////////*/

    /// Gated on the bound snapshot's CONSTITUTIONAL_ROLE. Not OPERATIONAL: that is the short-lane
    /// params role, and extending it to fund custody widens it into something it was not designed
    /// to be. For creator-admin'd instances the two are the same address today and diverge
    /// correctly at graduation.
    modifier onlyConstitutional(bytes32 instanceId) {
        address snapshot = _accounts[instanceId].snapshot;
        if (snapshot == address(0)) revert UnknownInstance(instanceId);
        if (!MerkleSnapshot(snapshot).hasRole(MerkleSnapshot(snapshot).CONSTITUTIONAL_ROLE(), msg.sender)) {
            revert NotConstitutional(instanceId, msg.sender);
        }
        _;
    }

    /// @inheritdoc IProvingVault
    function setPolicy(bytes32 instanceId, uint64 minPaidIntervalBlocks, uint96 maxPerRootUsd)
        external
        nonReentrant
        onlyConstitutional(instanceId)
    {
        Policy storage p = _policies[instanceId];
        p.minPaidIntervalBlocks = minPaidIntervalBlocks;
        p.maxPerRootUsd = maxPerRootUsd;
        emit PolicyUpdated(instanceId, minPaidIntervalBlocks, maxPerRootUsd);
    }

    /// @inheritdoc IProvingVault
    function requestWithdrawal(bytes32 instanceId, uint256 ethAmount, uint256 usdcAmount)
        external
        nonReentrant
        onlyConstitutional(instanceId)
    {
        if (ethAmount == 0 && usdcAmount == 0) revert ZeroAmount();
        Account storage a = _accounts[instanceId];
        if (ethAmount > a.ethBalance || usdcAmount > a.usdcBalance) {
            revert InsufficientBalance(a.ethBalance, a.usdcBalance);
        }

        // NOTE: requesting does NOT debit the balance. Debiting on request would hand the
        // community a free-roots machine: front-run a pending `submitAndClaim` with
        // `requestWithdrawal(everything)`, the root lands and `_claimed` is set while `_pay` finds
        // an empty tank, then `cancelWithdrawal` puts the money straight back. The prover has no
        // retry — `submitProof` reverts `StaleCheckpoint` for an applied checkpoint, and the
        // claim flag is set regardless — so the root is permanently unpaid. Repeat every epoch.
        // Funds therefore stay spendable on bounties for the whole notice period; a withdrawal
        // takes what is LEFT when it executes, which is the correct meaning of "this money is
        // working until I actually take it out".
        PendingWithdrawal storage w = _pending[instanceId];
        w.ethAmount += uint128(ethAmount);
        w.usdcAmount += uint128(usdcAmount);
        // Every request restarts the clock. Otherwise a community could keep a stale request open
        // and top it up the moment it wanted out, which is the notice period with extra steps.
        w.readyAt = uint64(block.timestamp) + WITHDRAWAL_NOTICE;
        emit WithdrawalRequested(instanceId, w.ethAmount, w.usdcAmount, w.readyAt);
    }

    /// @inheritdoc IProvingVault
    function cancelWithdrawal(bytes32 instanceId) external nonReentrant onlyConstitutional(instanceId) {
        if (_pending[instanceId].readyAt == 0) revert NothingPending(instanceId);
        // Nothing to restore: the request never took the funds out of the spendable balance.
        delete _pending[instanceId];
        emit WithdrawalCancelled(instanceId);
    }

    /// @inheritdoc IProvingVault
    function executeWithdrawal(bytes32 instanceId, address to) external nonReentrant onlyConstitutional(instanceId) {
        PendingWithdrawal memory w = _pending[instanceId];
        if (w.readyAt == 0) revert NothingPending(instanceId);
        if (block.timestamp < w.readyAt) revert WithdrawalNotReady(w.readyAt);
        if (to == address(0)) revert ZeroAmount();

        // Take what is LEFT. Bounties paid during the notice period came out of this tank, which
        // is what the tank is for; the withdrawal is not a claim on money already spent.
        Account storage a = _accounts[instanceId];
        uint128 eth = w.ethAmount > a.ethBalance ? a.ethBalance : w.ethAmount;
        uint128 usdcAmt = w.usdcAmount > a.usdcBalance ? a.usdcBalance : w.usdcAmount;
        a.ethBalance -= eth;
        a.usdcBalance -= usdcAmt;

        delete _pending[instanceId];
        if (usdcAmt != 0) USDC.safeTransfer(to, usdcAmt);
        if (eth != 0) {
            (bool sent,) = to.call{value: eth}("");
            require(sent, "ProvingVault: eth send failed");
        }
        emit WithdrawalExecuted(instanceId, to, eth, usdcAmt);
    }

    /// @inheritdoc IProvingVault
    function withdrawalNotice() external pure returns (uint64) {
        return WITHDRAWAL_NOTICE;
    }

    /*///////////////////////////////////////////////////////////////
                            PULL PAYMENTS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IProvingVault
    function creditOf(address account, address token) external view returns (uint256) {
        return _credit[account][token];
    }

    /// @inheritdoc IProvingVault
    /// @dev Pull, so a recipient that reverts on receive cannot revert a verified root. The worst
    ///      it can do is strand its own money.
    function withdrawCredit(address token, address to) external nonReentrant {
        uint256 amount = _credit[msg.sender][token];
        if (amount == 0) revert NoCredit(msg.sender, token);
        if (to == address(0)) revert ZeroAmount();
        _credit[msg.sender][token] = 0;

        if (token == ETH) {
            (bool sent,) = to.call{value: amount}("");
            require(sent, "ProvingVault: eth send failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        emit CreditWithdrawn(msg.sender, token, to, amount);
    }

    /*///////////////////////////////////////////////////////////////
                                VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IProvingVault
    function quote(bytes32 instanceId, uint256 checkpointId) external view returns (Quote memory q) {
        Account storage a = _accounts[instanceId];
        if (a.snapshot == address(0)) {
            q.reason = uint8(IneligibleReason.NoAccount);
            return q;
        }
        if (_claimed[instanceId][a.snapshot][checkpointId]) {
            q.reason = uint8(IneligibleReason.AlreadyClaimed);
            return q;
        }
        Policy storage p = _policies[instanceId];
        if (p.maxPerRootUsd == 0) {
            q.reason = uint8(IneligibleReason.PolicyDisabled);
            return q;
        }
        if (p.lastPaidBlock != 0 && block.number < uint256(p.lastPaidBlock) + p.minPaidIntervalBlocks) {
            q.reason = uint8(IneligibleReason.CadenceNotElapsed);
            return q;
        }
        uint256 cap = p.maxPerRootUsd;
        (uint256 ethUsdPrice, bool feedOk) = _ethUsd();
        q.payableUsd = _payableUsd(a, ethUsdPrice, feedOk);

        (, uint64 leafCount, uint64 anchorCount, bool sizeKnown) = _sizeOf(a.snapshot, checkpointId);
        uint8 band = bandOf(a.program, leafCount, anchorCount);
        if (!sizeKnown || band == 0) {
            q.reason = uint8(IneligibleReason.UnknownProgram);
            return q;
        }
        if (!feedOk) {
            q.reason = uint8(IneligibleReason.PriceFeedUnavailable);
            return q;
        }

        if (sizeKnown) {
            q.feeUsd = feePerRootUsd[a.program][band];
            if (q.feeUsd > cap) q.feeUsd = cap;
        }

        // Bounded so this view cannot overflow-revert. `quote()` is the pre-flight the operator
        // is instructed to trust before spending proving time; a reverting quote is
        // indistinguishable from an unreachable node and stops the loop for every instance.
        uint256 units = _refundSafeGasUnits(_min(nominalGasUnits, maxGasUnitsPerClaim));
        q.gasUsd = _gasUsd(units, ethUsdPrice);
        uint256 room = cap > q.feeUsd ? cap - q.feeUsd : 0;
        if (q.gasUsd > room) q.gasUsd = room;

        uint256 wanted = q.feeUsd + q.gasUsd;
        q.eligible = wanted != 0 && q.payableUsd >= wanted;
        if (!q.eligible && q.reason == uint8(IneligibleReason.None)) {
            q.reason = uint8(wanted == 0 ? IneligibleReason.UnknownProgram : IneligibleReason.InsufficientBalance);
        }
    }

    function _payableUsd(Account storage a, uint256 ethUsdPrice, bool feedOk) internal view returns (uint256) {
        uint256 usd = (uint256(a.usdcBalance) * USD) / USDC_SCALE;
        if (feedOk && ethUsdPrice != 0) {
            usd += (uint256(a.ethBalance) * ethUsdPrice) / 1e18;
        }
        return usd;
    }

    /// @inheritdoc IProvingVault
    function isClaimed(bytes32 instanceId, uint256 checkpointId) external view returns (bool) {
        return _claimed[instanceId][_accounts[instanceId].snapshot][checkpointId];
    }

    /// @inheritdoc IProvingVault
    function accountOf(bytes32 instanceId) external view returns (Account memory) {
        return _accounts[instanceId];
    }

    /// @inheritdoc IProvingVault
    function policyOf(bytes32 instanceId) external view returns (Policy memory) {
        return _policies[instanceId];
    }

    /// @inheritdoc IProvingVault
    function pendingWithdrawalOf(bytes32 instanceId) external view returns (PendingWithdrawal memory) {
        return _pending[instanceId];
    }
}
