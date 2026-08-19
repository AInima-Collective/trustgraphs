/**
 * The proving tank, as the UI needs to see it.
 *
 * Two questions drive every table here, and neither is answerable from `MerkleSnapshot` alone:
 *
 *   1. **How much is left, and how fast is it going?** A running balance plus cumulative totals,
 *      so "about three weeks of roots left at this rate" is arithmetic rather than a log scan.
 *   2. **Who is being paid?** The prover paid the gas; the *recipient* is what the guest committed
 *      in the journal. They differ whenever a root was relayed, and conflating them would make the
 *      front-running defence invisible in the UI.
 *
 * A skipped claim is recorded as carefully as a paid one. A root that landed and paid nothing is
 * exactly the signal that a tank ran dry or a price feed went stale, and without it "nobody is
 * proving this" and "everybody is proving it for free" look identical.
 */
import { ponder } from 'ponder:registry'
import {
  provingVaultAccount,
  provingVaultClaim,
  provingVaultCredit,
  provingVaultDeposit,
} from 'ponder:schema'

const ZERO = '0x0000000000000000000000000000000000000000' as const
const ZERO_PROGRAM = `0x${'00'.repeat(32)}` as `0x${string}`

/**
 * M0 hazard-sweep note (GOAL clarification 2): every account/credit mutation in this file is an
 * upsert, never a bare `.update()`. The vault ABI the indexer carries is events-only — there is no
 * account getter to read a missing row back from — so a row that first enters our universe
 * mid-life (a start block after its `AccountBound`, a rebound account, a replayed range) is
 * materialized from the event itself with zero baselines: balances and totals mean "since
 * observation began", exactly the semantics `Deposited` already established. `AccountBound`
 * or a later `Deposited` refreshes snapshot/program when they are seen.
 */
const accountBaseline = (
  event: { log: { address: `0x${string}` }; block: { timestamp: bigint } },
  chainId: number,
  instanceId: `0x${string}`
) => ({
  id: instanceId,
  chainId: `${chainId}`,
  vault: event.log.address,
  snapshot: ZERO,
  program: ZERO_PROGRAM,
  ethBalance: 0n,
  usdcBalance: 0n,
  totalDepositedEth: 0n,
  totalDepositedUsdc: 0n,
  totalSpentEth: 0n,
  totalSpentUsdc: 0n,
  lastPaidBlock: 0n,
  withdrawalReadyAt: 0n,
  updatedAt: event.block.timestamp,
})

/** `AccountBound` is the first thing that happens to an instance, so it creates the row. */
ponder.on('provingVault:AccountBound', async ({ event, context }) => {
  const { instanceId, snapshot, program } = event.args
  await context.db
    .insert(provingVaultAccount)
    .values({
      id: instanceId,
      chainId: `${context.chain.id}`,
      vault: event.log.address,
      snapshot,
      program,
      ethBalance: 0n,
      usdcBalance: 0n,
      totalDepositedEth: 0n,
      totalDepositedUsdc: 0n,
      totalSpentEth: 0n,
      totalSpentUsdc: 0n,
      lastPaidBlock: 0n,
      withdrawalReadyAt: 0n,
      updatedAt: event.block.timestamp,
    })
    // A migration re-emits this with a new snapshot; the balances must survive it.
    .onConflictDoUpdate(() => ({
      snapshot,
      program,
      updatedAt: event.block.timestamp,
    }))
})

ponder.on('provingVault:Deposited', async ({ event, context }) => {
  const { instanceId, token, from, amount } = event.args
  const isEth = token === ZERO

  await context.db.insert(provingVaultDeposit).values({
    id: event.id,
    instanceId,
    chainId: `${context.chain.id}`,
    token,
    from,
    amount,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  })

  // `AccountBound` fires first on a fresh account, but ordering across a reorg is not something to
  // rely on for a balance — upsert so a deposit can never be dropped for want of a row.
  await context.db
    .insert(provingVaultAccount)
    .values({
      ...accountBaseline(event, context.chain.id, instanceId),
      ethBalance: isEth ? amount : 0n,
      usdcBalance: isEth ? 0n : amount,
      totalDepositedEth: isEth ? amount : 0n,
      totalDepositedUsdc: isEth ? 0n : amount,
    })
    .onConflictDoUpdate((row) => ({
      ethBalance: isEth ? row.ethBalance + amount : row.ethBalance,
      usdcBalance: isEth ? row.usdcBalance : row.usdcBalance + amount,
      totalDepositedEth: isEth
        ? row.totalDepositedEth + amount
        : row.totalDepositedEth,
      totalDepositedUsdc: isEth
        ? row.totalDepositedUsdc
        : row.totalDepositedUsdc + amount,
      updatedAt: event.block.timestamp,
    }))
})

ponder.on('provingVault:Claimed', async ({ event, context }) => {
  const {
    instanceId,
    checkpointId,
    recipient,
    submitter,
    feeUsd,
    gasUsd,
    ethSpent,
    usdcSpent,
  } = event.args

  await context.db.insert(provingVaultClaim).values({
    id: event.id,
    instanceId,
    chainId: `${context.chain.id}`,
    checkpointId,
    recipient,
    submitter,
    feeUsd,
    gasUsd,
    ethSpent,
    usdcSpent,
    skipped: false,
    reason: 0,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  })

  // Upsert, not update: a claim must never wedge the indexer for want of an account row (see the
  // hazard-sweep note above). A fresh row means the bind predates observation; the spend still
  // counts from a zero baseline.
  await context.db
    .insert(provingVaultAccount)
    .values({
      ...accountBaseline(event, context.chain.id, instanceId),
      ethBalance: -ethSpent,
      usdcBalance: -usdcSpent,
      totalSpentEth: ethSpent,
      totalSpentUsdc: usdcSpent,
      lastPaidBlock: event.block.number,
    })
    .onConflictDoUpdate((row) => ({
      ethBalance: row.ethBalance - ethSpent,
      usdcBalance: row.usdcBalance - usdcSpent,
      totalSpentEth: row.totalSpentEth + ethSpent,
      totalSpentUsdc: row.totalSpentUsdc + usdcSpent,
      lastPaidBlock: event.block.number,
      updatedAt: event.block.timestamp,
    }))
})

/** A root that landed and paid nothing. The tank is unchanged; the reason is the point. */
ponder.on('provingVault:ClaimSkipped', async ({ event, context }) => {
  const { instanceId, checkpointId, reason } = event.args
  await context.db.insert(provingVaultClaim).values({
    id: event.id,
    instanceId,
    chainId: `${context.chain.id}`,
    checkpointId,
    recipient: null,
    submitter: null,
    feeUsd: 0n,
    gasUsd: 0n,
    ethSpent: 0n,
    usdcSpent: 0n,
    skipped: true,
    reason,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  })
})

const creditId = (account: string, token: string) => `${account}-${token}`

ponder.on('provingVault:CreditAccrued', async ({ event, context }) => {
  const { account, token, amount } = event.args
  await context.db
    .insert(provingVaultCredit)
    .values({
      id: creditId(account, token),
      chainId: `${context.chain.id}`,
      account,
      token,
      accrued: amount,
      withdrawn: 0n,
      outstanding: amount,
      updatedAt: event.block.timestamp,
    })
    .onConflictDoUpdate((row) => ({
      accrued: row.accrued + amount,
      outstanding: row.outstanding + amount,
      updatedAt: event.block.timestamp,
    }))
})

ponder.on('provingVault:CreditWithdrawn', async ({ event, context }) => {
  const { account, token, amount } = event.args
  // Upsert like `CreditAccrued` above: a withdrawal whose accrual predates observation records
  // what we saw (withdrawn = amount from a zero baseline) instead of wedging on a missing row.
  await context.db
    .insert(provingVaultCredit)
    .values({
      id: creditId(account, token),
      chainId: `${context.chain.id}`,
      account,
      token,
      accrued: 0n,
      withdrawn: amount,
      outstanding: -amount,
      updatedAt: event.block.timestamp,
    })
    .onConflictDoUpdate((row) => ({
      withdrawn: row.withdrawn + amount,
      outstanding: row.outstanding - amount,
      updatedAt: event.block.timestamp,
    }))
})

/*///////////////////////////////////////////////////////////////
                      WITHDRAWAL NOTICE
//////////////////////////////////////////////////////////////*/
//
// A pending withdrawal does NOT reduce the spendable balance — that was how an earlier version of
// the vault let a community take roots for free, and the fix was to leave the money at work for
// the whole notice period. So these handlers record the notice, and only `Executed` moves a
// balance.

// All three withdrawal handlers upsert (hazard-sweep note at the top of this file): the notice
// state is carried entirely by the event, so a missing account row is materialized at baseline
// rather than wedging the indexer.

ponder.on('provingVault:WithdrawalRequested', async ({ event, context }) => {
  const { instanceId, readyAt } = event.args
  await context.db
    .insert(provingVaultAccount)
    .values({
      ...accountBaseline(event, context.chain.id, instanceId),
      withdrawalReadyAt: BigInt(readyAt),
    })
    .onConflictDoUpdate({
      withdrawalReadyAt: BigInt(readyAt),
      updatedAt: event.block.timestamp,
    })
})

ponder.on('provingVault:WithdrawalCancelled', async ({ event, context }) => {
  await context.db
    .insert(provingVaultAccount)
    .values(accountBaseline(event, context.chain.id, event.args.instanceId))
    .onConflictDoUpdate({
      withdrawalReadyAt: 0n,
      updatedAt: event.block.timestamp,
    })
})

ponder.on('provingVault:WithdrawalExecuted', async ({ event, context }) => {
  const { instanceId, ethAmount, usdcAmount } = event.args
  await context.db
    .insert(provingVaultAccount)
    .values({
      ...accountBaseline(event, context.chain.id, instanceId),
      ethBalance: -ethAmount,
      usdcBalance: -usdcAmount,
    })
    .onConflictDoUpdate((row) => ({
      ethBalance: row.ethBalance - ethAmount,
      usdcBalance: row.usdcBalance - usdcAmount,
      withdrawalReadyAt: 0n,
      updatedAt: event.block.timestamp,
    }))
})
