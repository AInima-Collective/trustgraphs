/**
 * The proving tank's indexed balances, settled spend, and recent activity.
 *
 * Runway is deliberately not calculated here: valuing a live ETH balance requires the vault's
 * current feed and freshness bounds. The settings page combines this settled 30-day USD spend
 * with those live reads and hides the estimate when it cannot value the balance safely.
 */
import { and, desc, eq, gte } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from 'ponder:api'
import schema from 'ponder:schema'

const app = new Hono()

/** Seconds in the window a burn rate is measured over. Thirty days: shorter and one expensive */
/** epoch dominates it; longer and it stops reflecting a change of cadence. */
const BURN_WINDOW_SECONDS = 30n * 24n * 60n * 60n
const RECENT_ACTIVITY_LIMIT = 12

app.get('/:instanceId', async (c) => {
  const instanceId = c.req.param('instanceId').toLowerCase() as `0x${string}`

  const [account] = await db
    .select()
    .from(schema.provingVaultAccount)
    .where(eq(schema.provingVaultAccount.id, instanceId))
    .limit(1)

  if (!account) {
    // Not an error. Most instances have no tank, and the honest answer is "this one is either
    // curated, self-proving, or not being proven at all" — which the UI must be able to say.
    return c.json({ funded: false, instanceId })
  }

  const now = BigInt(Math.floor(Date.now() / 1000))
  const since = now > BURN_WINDOW_SECONDS ? now - BURN_WINDOW_SECONDS : 0n

  const recentWindow = await db
    .select()
    .from(schema.provingVaultClaim)
    .where(
      and(
        eq(schema.provingVaultClaim.instanceId, instanceId),
        gte(schema.provingVaultClaim.timestamp, since)
      )
    )

  const paid = recentWindow.filter((r) => !r.skipped)
  const spentEth = paid.reduce((a, r) => a + r.ethSpent, 0n)
  const spentUsdc = paid.reduce((a, r) => a + r.usdcSpent, 0n)
  // Claims already carry their settled USD value. Keep the burn denominator in that common unit;
  // adding wei to 6dp USDC (the old implementation) silently treated 1 ETH as 1 USDC.
  const spentUsd = paid.reduce((a, r) => a + r.feeUsd + r.gasUsd, 0n)

  // Roots per window, and value per window. Both are needed: a tank can run dry either because
  // roots got expensive or because they got frequent, and the two have different fixes.
  const rootsInWindow = paid.length
  const [lastPaidRows, recentDeposits, recentClaims] = await Promise.all([
    db
      .select()
      .from(schema.provingVaultClaim)
      .where(
        and(
          eq(schema.provingVaultClaim.instanceId, instanceId),
          eq(schema.provingVaultClaim.skipped, false)
        )
      )
      .orderBy(desc(schema.provingVaultClaim.blockNumber))
      .limit(1),
    db
      .select()
      .from(schema.provingVaultDeposit)
      .where(eq(schema.provingVaultDeposit.instanceId, instanceId))
      .orderBy(desc(schema.provingVaultDeposit.blockNumber))
      .limit(RECENT_ACTIVITY_LIMIT),
    db
      .select()
      .from(schema.provingVaultClaim)
      .where(eq(schema.provingVaultClaim.instanceId, instanceId))
      .orderBy(desc(schema.provingVaultClaim.blockNumber))
      .limit(RECENT_ACTIVITY_LIMIT),
  ])
  const lastPaid = lastPaidRows[0]

  // Skipped claims since the last paid one. This is the "your tank ran dry" signal, and it is the
  // difference between a community that is being proven for free and one that is not being proven.
  const skippedSinceLastPaid = recentWindow.filter(
    (r) => r.skipped && (!lastPaid || r.blockNumber > lastPaid.blockNumber)
  )

  return c.json({
    funded: true,
    instanceId,
    vault: account.vault,
    snapshot: account.snapshot,
    program: account.program,
    ethBalance: account.ethBalance.toString(),
    usdcBalance: account.usdcBalance.toString(),
    totalDepositedEth: account.totalDepositedEth.toString(),
    totalDepositedUsdc: account.totalDepositedUsdc.toString(),
    totalSpentEth: account.totalSpentEth.toString(),
    totalSpentUsdc: account.totalSpentUsdc.toString(),
    lastPaidBlock: account.lastPaidBlock.toString(),
    withdrawalReadyAt: account.withdrawalReadyAt.toString(),
    updatedAt: account.updatedAt.toString(),
    burn: {
      windowSeconds: Number(BURN_WINDOW_SECONDS),
      rootsInWindow,
      spentEth: spentEth.toString(),
      spentUsdc: spentUsdc.toString(),
      /** USD scaled by 1e8, as settled by the vault at each claim. */
      spentUsd: spentUsd.toString(),
    },
    lastPaidAt: lastPaid ? Number(lastPaid.timestamp) : null,
    unpaidRootsSinceLastPayment: skippedSinceLastPaid.length,
    recentDeposits: recentDeposits.map((deposit) => ({
      id: deposit.id,
      token: deposit.token,
      from: deposit.from,
      amount: deposit.amount.toString(),
      blockNumber: deposit.blockNumber.toString(),
      timestamp: deposit.timestamp.toString(),
    })),
    recentClaims: recentClaims.map((claim) => ({
      id: claim.id,
      checkpointId: claim.checkpointId.toString(),
      recipient: claim.recipient,
      submitter: claim.submitter,
      feeUsd: claim.feeUsd.toString(),
      gasUsd: claim.gasUsd.toString(),
      ethSpent: claim.ethSpent.toString(),
      usdcSpent: claim.usdcSpent.toString(),
      skipped: claim.skipped,
      reason: claim.reason,
      blockNumber: claim.blockNumber.toString(),
      timestamp: claim.timestamp.toString(),
    })),
  })
})

export default app
