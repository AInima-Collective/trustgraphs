// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IProvingVault
/// @notice A per-instance tank a community tops up so somebody keeps proving its scores.
///
/// The hosted operator proves a curated set on us. Everyone else either self-proves — permissionless,
/// documented, free forever — or funds one of these, and the same loop pays whoever produces the
/// root. Frozen at the proof-scheduler interface freeze so the vault, the indexer and the frontend
/// can be built in parallel; the implementation lands at M3.
///
/// Five things are load-bearing and none of them are conventions:
///
/// 1. **`submitAndClaim` is the payout seam.** The vault forwards to `snapshot.submitProof(...)`,
///    confirms `lastAppliedCheckpoint == checkpointId`, marks the checkpoint claimed, and credits.
///    A `MerkleSnapshot` hook cannot be the seam: `IMerkleSnapshotHook.onMerkleUpdate` sees only a
///    `MerkleState` — no checkpoint, no submitter, no recipient. Recorded so it is not
///    re-litigated. Claiming stays opt-in: a root landed through a plain `submitProof` is perfectly
///    valid, it just pays nobody.
///
/// 2. **The split that kills front-running.** `provingFee` follows `args.recipient`, which the
///    guest committed and `MerkleSnapshot` folded into the journal digest. `gasReimbursement`
///    follows `msg.sender`, whoever actually paid. Copy a pending `submitAndClaim` out of the
///    mempool and you pay the original prover their fee and refund yourself only gas.
///
/// 3. **Under partial funding the fee is paid FIRST.** The other order lets a copier consume the
///    remaining balance as gas reimbursement and leave the prover with nothing.
///
/// 4. **Accounts bind to a snapshot at first deposit**, never re-resolved per call. Resolving
///    through `InstanceRegistry` on every claim would let the registry's `OPERATOR_ROLE` redirect
///    a funded community's balance to a snapshot of its choosing. Migration is explicit and
///    community-authorized.
///
/// 5. **Money moves by pull.** Payouts are credits the recipient withdraws. A recipient that
///    reverts on receive must never be able to revert a successfully verified root.
///
/// Design: `research/PROOF_SCHEDULER.md` §4 (economics), §7-§10 (decisions). Two decisions there
/// are superseded and are NOT implemented here: §4.3's commit-reveal (replaced by
/// recipient-in-journal) and §4.2's free-floor-for-all (replaced by curated subsidy).
interface IProvingVault {
    /*///////////////////////////////////////////////////////////////
                                TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice One community's tank.
    struct Account {
        /// @notice The `MerkleSnapshot` this balance may ever be spent on. Bound at first deposit
        ///         by resolving `InstanceRegistry` exactly once; zero means "no deposit yet".
        address snapshot;
        /// @notice The program id (`keccak256("trust-graph")` etc.), also bound at first deposit.
        ///         Picks the fee band function; an unknown program prices at zero, never cheapest.
        bytes32 program;
        /// @notice Wei available to pay bounties.
        uint128 ethBalance;
        /// @notice USDC (6dp) available to pay bounties. Valued at $1 in v1 — deliberate;
        ///         `maxPerRootUsd` bounds the exposure a depeg could create.
        uint128 usdcBalance;
    }

    /// @notice The on-chain half of "a stranger cannot drain the tank faster than we chose".
    /// @dev Operator policy cannot bind a stranger, and `EPOCH_FLOOR` binds only at instance
    ///      creation (`setEpochLength` is constitutional, so any creator can lower their own epoch
    ///      afterwards). So the paid cadence has to live here. This is the only enforceable one of
    ///      the three intervals; `INSTANCE_FACTORY.md` §2.2 and `PROOF_SCHEDULER.md` §4.2 both
    ///      claim the creation floor bounds ongoing cost, and both are corrected.
    struct Policy {
        /// @notice Minimum blocks between two PAID roots. A root landing sooner still applies —
        ///         it just pays nothing. Zero = pay for every root the snapshot accepts.
        uint64 minPaidIntervalBlocks;
        /// @notice Hard ceiling on the total value of one claim, in USD scaled by 1e8.
        ///         Zero = this instance pays no bounty at all.
        uint96 maxPerRootUsd;
        /// @notice Block of the last claim paid out of this account.
        uint64 lastPaidBlock;
    }

    /// @notice A withdrawal in its notice period.
    /// @dev Notice rather than instant, because instant withdrawal lets a community rug a prover
    ///      mid-proof — precisely the reliability the hosted service sells. Top-ups stay instant,
    ///      and anyone may top up any instance.
    struct PendingWithdrawal {
        uint128 ethAmount;
        uint128 usdcAmount;
        /// @notice Timestamp from which `executeWithdrawal` succeeds. Zero = nothing pending.
        uint64 readyAt;
    }

    /// @notice Everything `MerkleSnapshot.submitProof` needs, forwarded verbatim.
    struct SubmitArgs {
        uint256 checkpointId;
        bytes32 outputRoot;
        bytes32 ipfsHash;
        string ipfsHashCid;
        uint256 totalValue;
        bytes32 skippedDigest;
        /// @notice The journal-committed payee. The fee follows THIS, not `msg.sender`.
        address recipient;
        bytes proof;
        /// @notice The least the prover will accept, in USD scaled by 1e8. Below it, the whole
        ///         call reverts and nothing lands.
        /// @dev The prover's own guard, and the answer to every "the payout was zeroed in the
        ///      same block" attack: a community that front-runs `setPolicy(0, 0)`, or drains its
        ///      own tank, or lets the price feed go stale, now gets a reverted transaction rather
        ///      than a free root. Zero means "land it regardless of payment", which is the
        ///      correct setting for a curated instance or a community self-proving.
        uint256 minPayoutUsd;
    }

    /// @notice What a claim would pay right now, and whether it would pay at all.
    struct Quote {
        /// @notice Proving fee in USD, scaled by 1e8. Zero when the program/band is unpriced or
        ///         the price feed is unusable.
        uint256 feeUsd;
        /// @notice Conservative gas reimbursement in USD, scaled by 1e8, priced at `block.basefee`.
        uint256 gasUsd;
        /// @notice Combined value in USD (1e8) the account can actually cover right now.
        uint256 payableUsd;
        /// @notice False when the cadence guard, the per-root cap, or an empty tank would make
        ///         this claim pay nothing.
        bool eligible;
        /// @notice Machine-readable reason when `eligible` is false. See `IneligibleReason`.
        uint8 reason;
    }

    /// @notice Why a quote is ineligible. The operator turns these into holds, not retries.
    enum IneligibleReason {
        None,
        NoAccount,
        PolicyDisabled, // maxPerRootUsd == 0
        CadenceNotElapsed,
        InsufficientBalance,
        UnknownProgram,
        /// @notice Retained for the UI's vault panel. Deliberately NOT a blocker: a pending
        ///         withdrawal no longer removes funds from the spendable balance, so a prover
        ///         proving today is still paid today. Making it a blocker was how an earlier
        ///         version let a community take roots for free.
        WithdrawalPending
    }

    /*///////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Emitted the first time an instance is funded, pinning what its balance may buy.
    event AccountBound(bytes32 indexed instanceId, address indexed snapshot, bytes32 program);

    /// @notice A top-up. `token` is `address(0)` for ETH.
    event Deposited(bytes32 indexed instanceId, address indexed token, address indexed from, uint256 amount);

    /// @notice A root landed through the vault and the bounty was credited.
    /// @param recipient The journal-committed payee (fee).
    /// @param submitter `msg.sender` (gas reimbursement).
    event Claimed(
        bytes32 indexed instanceId,
        uint256 indexed checkpointId,
        address indexed recipient,
        address submitter,
        uint256 feeUsd,
        uint256 gasUsd,
        uint256 ethSpent,
        uint256 usdcSpent
    );

    /// @notice A root landed through the vault but paid nothing (empty tank, cadence, stale feed).
    ///         Emitted rather than reverted: correctness fails open, money fails closed.
    event ClaimSkipped(bytes32 indexed instanceId, uint256 indexed checkpointId, uint8 reason);

    /// @notice Pull-payment credit accrued. `token` is `address(0)` for ETH.
    event CreditAccrued(address indexed account, address indexed token, uint256 amount);

    /// @notice Pull-payment credit withdrawn.
    event CreditWithdrawn(address indexed account, address indexed token, address to, uint256 amount);

    event WithdrawalRequested(bytes32 indexed instanceId, uint256 ethAmount, uint256 usdcAmount, uint64 readyAt);
    event WithdrawalCancelled(bytes32 indexed instanceId);
    event WithdrawalExecuted(bytes32 indexed instanceId, address to, uint256 ethAmount, uint256 usdcAmount);

    event PolicyUpdated(bytes32 indexed instanceId, uint64 minPaidIntervalBlocks, uint96 maxPerRootUsd);
    event FeeScheduleUpdated(bytes32 indexed program, uint8 indexed band, uint256 usdPerRoot);
    event PriceFeedUpdated(address feed, uint64 maxStaleness);

    /*///////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAmount();
    error UnknownInstance(bytes32 instanceId);
    /// @notice The instance's registry row names a different snapshot than the bound one. Binding
    ///         is deliberately not refreshed; migration is an explicit, authorized action.
    error SnapshotMismatch(address bound, address registry);
    error NotConstitutional(bytes32 instanceId, address caller);
    /// @notice This checkpoint has already paid out. One root, one bounty, ever.
    error AlreadyClaimed(bytes32 instanceId, uint256 checkpointId);
    /// @notice `submitProof` returned without advancing `lastAppliedCheckpoint` to this id.
    error CheckpointNotApplied(uint256 expected, uint256 actual);
    /// @notice A withdrawal request larger than the spendable balance.
    error InsufficientBalance(uint128 ethBalance, uint128 usdcBalance);
    error NothingPending(bytes32 instanceId);
    error WithdrawalNotReady(uint64 readyAt);
    error NoCredit(address account, address token);
    /// @notice Band 0 is the "we do not price this" sentinel and can never carry a price.
    error UnpricedBandIsReserved();
    /// @notice The price feed does not report 8 decimals, which every conversion here assumes.
    error FeedDecimalsUnsupported(uint8 decimals);
    /// @notice The claim would pay less than `SubmitArgs.minPayoutUsd`.
    error PayoutBelowMinimum(uint256 offeredUsd, uint256 requiredUsd);
    /// @notice `claim` called for a checkpoint whose root has not been applied.
    error CheckpointNotApplied2(uint256 checkpointId);
    /// @notice This exact proven statement has already paid a bounty under another checkpoint id.
    error StatementAlreadyPaid(bytes32 statement);

    /*///////////////////////////////////////////////////////////////
                            FUNDING
    //////////////////////////////////////////////////////////////*/

    /// @notice Top up an instance's tank with ETH. Permissionless: anyone may fund any instance,
    ///         which is what lets `TrustgraphsFactory.createInstance` forward `msg.value` and lets
    ///         a supporter endow a community they are not a member of.
    /// @dev The first deposit binds `(snapshot, program)` by resolving `InstanceRegistry` once.
    function depositETH(bytes32 instanceId) external payable;

    /// @notice Top up with USDC (pull; caller must have approved). Valued at $1 in v1.
    function depositUSDC(bytes32 instanceId, uint256 amount) external;

    /*///////////////////////////////////////////////////////////////
                        SUBMIT + CLAIM
    //////////////////////////////////////////////////////////////*/

    /// @notice Land a root through the vault and claim the bounty for it.
    /// @dev Order is fixed: forward → confirm applied → mark claimed → credit fee to
    ///      `args.recipient` → credit gas to `msg.sender`. Fee before gas so a copier cannot eat
    ///      the remaining balance as reimbursement. A `StaleCheckpoint` revert propagates: someone
    ///      landed a newer root, and the operator treats that as success, not failure.
    /// @return feeUsd Proving fee credited to `args.recipient`, in USD scaled by 1e8.
    /// @return gasUsd Gas reimbursement credited to `msg.sender`, in USD scaled by 1e8.
    /// @dev Both legs are quoted and capped in USD, then settled out of the account ETH-first and
    ///      USDC-second (USDC valued at $1 in v1 — deliberate; `maxPerRootUsd` bounds the exposure
    ///      a depeg could create). The `Claimed` event carries the token amounts actually moved.
    function submitAndClaim(bytes32 instanceId, SubmitArgs calldata args)
        external
        returns (uint256 feeUsd, uint256 gasUsd);

    /// @notice What `submitAndClaim` would pay for this instance at this block.
    /// @dev The operator calls this BEFORE proving. Discovering mid-flight that a proof will not
    ///      be paid for is the failure this exists to prevent.
    function quote(bytes32 instanceId, uint64 leafCount, uint64 anchorCount) external view returns (Quote memory);

    /// @notice Whether a bounty was already paid for this checkpoint.
    function isClaimed(bytes32 instanceId, uint256 checkpointId) external view returns (bool);

    /// @notice Pay the bounty for a root that has ALREADY been applied, to the recipient the
    ///         journal committed.
    /// @dev The other half of "the bounty cannot be stolen". `MerkleSnapshot.submitProof` is
    ///      permissionless, so anyone can lift a pending claim's proof out of the mempool and land
    ///      it directly, bypassing the vault: the prover's `submitAndClaim` then reverts
    ///      `StaleCheckpoint` and, because monotonicity is permanent, the fee would be unpayable
    ///      by anyone. This settles against `MerkleSnapshot.checkpointRecipient`, so the copier
    ///      buys nothing and the prover is still paid. Permissionless: anyone may trigger the
    ///      payment, but it can only ever go to the journal's recipient.
    function claim(bytes32 instanceId, uint256 checkpointId) external returns (uint256 feeUsd);

    /*///////////////////////////////////////////////////////////////
                        PULL PAYMENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Credit owed to `account` in `token` (`address(0)` = ETH).
    function creditOf(address account, address token) external view returns (uint256);

    /// @notice Withdraw your own credit. A revert here cannot affect any root.
    function withdrawCredit(address token, address to) external;

    /*///////////////////////////////////////////////////////////////
                    COMMUNITY CONTROLS (constitutional)
    //////////////////////////////////////////////////////////////*/

    /// @notice Set the paid cadence and the per-root cap.
    /// @dev Gated on the bound snapshot's `CONSTITUTIONAL_ROLE`, not `OPERATIONAL_ROLE`.
    ///      Operational is the short-lane params role; extending it to fund custody widens it into
    ///      something it was not designed to be. For creator-admin'd instances the two are the
    ///      same address today and diverge correctly at graduation.
    function setPolicy(bytes32 instanceId, uint64 minPaidIntervalBlocks, uint96 maxPerRootUsd) external;

    /// @notice Start the withdrawal notice period.
    function requestWithdrawal(bytes32 instanceId, uint256 ethAmount, uint256 usdcAmount) external;

    /// @notice Abandon a pending withdrawal and put the funds back to work.
    function cancelWithdrawal(bytes32 instanceId) external;

    /// @notice Complete a withdrawal whose notice period has elapsed.
    function executeWithdrawal(bytes32 instanceId, address to) external;

    /// @notice Re-resolve this account's snapshot from the registry: the explicit,
    ///         community-authorized migration that bind-at-first-deposit implies.
    /// @dev Gated on the CURRENTLY bound snapshot's constitutional role, so a registry update on
    ///      its own still redirects nothing. Without this, binding would be a trap rather than a
    ///      protection: anyone can bind an account with one wei, and a community that later
    ///      migrated would find its tank stranded on the old snapshot forever.
    function migrate(bytes32 instanceId) external;

    /// @notice The notice period, in seconds.
    function withdrawalNotice() external view returns (uint64);

    /*///////////////////////////////////////////////////////////////
                            PRICING
    //////////////////////////////////////////////////////////////*/

    /// @notice USD per landed root for a program's size band, scaled by 1e8.
    /// @dev The band function is PER PROGRAM and defaults to "unsupported ⇒ zero fee", so an
    ///      unknown or oversized program can never claim the cheapest band. A lane-2-only
    ///      program's `leafCount` is permanently zero, so a shared leafCount-derived band would
    ///      misprice it as the smallest possible graph.
    function feePerRootUsd(bytes32 program, uint8 band) external view returns (uint256);

    /// @notice The size band this program assigns to a checkpoint. Reverts nothing: an unsupported
    ///         program or an oversized instance returns a band whose fee is zero.
    /// @dev The operator's `cycle_limit` and this function's top band must name the same boundary.
    ///      That agreement is a test, not a comment.
    function bandOf(bytes32 program, uint64 leafCount, uint64 anchorCount) external view returns (uint8);

    /// @notice Set a program/band price. FEE_SETTER is us in v1 (§8.2); moving it behind the
    ///         operational timelock is a recorded open question, not a shipped feature.
    function setFeePerRootUsd(bytes32 program, uint8 band, uint256 usdPerRoot) external;

    /*///////////////////////////////////////////////////////////////
                            VIEWS
    //////////////////////////////////////////////////////////////*/

    function accountOf(bytes32 instanceId) external view returns (Account memory);
    function policyOf(bytes32 instanceId) external view returns (Policy memory);
    function pendingWithdrawalOf(bytes32 instanceId) external view returns (PendingWithdrawal memory);
}
