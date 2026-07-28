/**
 * The proving tank, as one JSON object the UI can render without arithmetic.
 *
 * Deliberately answers the question a community actually asks — "how long until my scores stop
 * refreshing?" — rather than returning a balance and leaving the honest part to the client. A burn
 * rate computed in three different places is a burn rate that will disagree with itself.
 */
import { and, desc, eq, gte } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from 'ponder:api'
import schema from 'ponder:schema'

const app = new Hono()

/** Seconds in the window a burn rate is measured over. Thirty days: shorter and one expensive */
/** epoch dominates it; longer and it stops reflecting a change of cadence. */
const BURN_WINDOW_SECONDS = 30n * 24n * 60n * 60n

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

  const recent = await db
    .select()
    .from(schema.provingVaultClaim)
    .where(
      and(
        eq(schema.provingVaultClaim.instanceId, instanceId),
        gte(schema.provingVaultClaim.timestamp, since)
      )
    )

  const paid = recent.filter((r) => !r.skipped)
  const spentEth = paid.reduce((a, r) => a + r.ethSpent, 0n)
  const spentUsdc = paid.reduce((a, r) => a + r.usdcSpent, 0n)

  // Roots per window, and value per window. Both are needed: a tank can run dry either because
  // roots got expensive or because they got frequent, and the two have different fixes.
  const rootsInWindow = paid.length
  const secondsCovered = rootsInWindow > 0 ? BURN_WINDOW_SECONDS : 0n

  // "About N weeks left" — deliberately the only projection, and null when there is no evidence
  // for one. A made-up runway is worse than no runway.
  let secondsRemaining: number | null = null
  if (rootsInWindow > 0 && (spentEth > 0n || spentUsdc > 0n)) {
    const spentTotal = spentEth + spentUsdc * 10n ** 12n // crude common scale, ranking only
    const balanceTotal = account.ethBalance + account.usdcBalance * 10n ** 12n
    if (spentTotal > 0n) {
      secondsRemaining = Number((balanceTotal * secondsCovered) / spentTotal)
    }
  }

  const [lastPaid] = await db
    .select()
    .from(schema.provingVaultClaim)
    .where(
      and(
        eq(schema.provingVaultClaim.instanceId, instanceId),
        eq(schema.provingVaultClaim.skipped, false)
      )
    )
    .orderBy(desc(schema.provingVaultClaim.blockNumber))
    .limit(1)

  // Skipped claims since the last paid one. This is the "your tank ran dry" signal, and it is the
  // difference between a community that is being proven for free and one that is not being proven.
  const skippedSinceLastPaid = recent.filter(
    (r) => r.skipped && (!lastPaid || r.blockNumber > lastPaid.blockNumber)
  )

  return c.json({
    funded: true,
    instanceId,
    vault: account.vault,
    snapshot: account.snapshot,
    ethBalance: account.ethBalance.toString(),
    usdcBalance: account.usdcBalance.toString(),
    totalDepositedEth: account.totalDepositedEth.toString(),
    totalDepositedUsdc: account.totalDepositedUsdc.toString(),
    totalSpentEth: account.totalSpentEth.toString(),
    totalSpentUsdc: account.totalSpentUsdc.toString(),
    lastPaidBlock: account.lastPaidBlock.toString(),
    withdrawalReadyAt: account.withdrawalReadyAt.toString(),
    burn: {
      windowSeconds: Number(BURN_WINDOW_SECONDS),
      rootsInWindow,
      spentEth: spentEth.toString(),
      spentUsdc: spentUsdc.toString(),
      /** Null when there is not enough history to project one honestly. */
      secondsRemaining,
    },
    lastPaidAt: lastPaid ? Number(lastPaid.timestamp) : null,
    unpaidRootsSinceLastPayment: skippedSinceLastPaid.length,
  })
})

/** What an address is owed and can pull. */
app.get('/credit/:account', async (c) => {
  const account = c.req.param('account').toLowerCase() as `0x${string}`
  const rows = await db
    .select()
    .from(schema.provingVaultCredit)
    .where(eq(schema.provingVaultCredit.account, account))
  return c.json(
    rows.map((r) => ({
      token: r.token,
      accrued: r.accrued.toString(),
      withdrawn: r.withdrawn.toString(),
      outstanding: r.outstanding.toString(),
    }))
  )
})

export default app
