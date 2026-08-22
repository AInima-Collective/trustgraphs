import { and, count, eq, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from 'ponder:api'
import { easAttestation } from 'ponder:schema'

const app = new Hono()

// Get attestation counts for all accounts
app.get('/counts', async (c) => {
  try {
    // Get sent counts (where account is attester)
    const sentCounts = await db
      .select({
        account: easAttestation.attester,
        sent: count(easAttestation.uid),
      })
      .from(easAttestation)
      // not revoked, nor self-attested
      .where(
        and(
          eq(easAttestation.revocationTime, 0n),
          ne(easAttestation.attester, easAttestation.recipient)
        )
      )
      .groupBy(easAttestation.attester)

    // Get received counts (where account is recipient)
    const receivedCounts = await db
      .select({
        account: easAttestation.recipient,
        received: count(easAttestation.uid),
      })
      .from(easAttestation)
      // not revoked, nor self-attested
      .where(
        and(
          eq(easAttestation.revocationTime, 0n),
          ne(easAttestation.attester, easAttestation.recipient)
        )
      )
      .groupBy(easAttestation.recipient)

    // Combine the results
    const accountCounts: Record<string, { sent: number; received: number }> = {}

    // Add sent counts
    for (const item of sentCounts) {
      if (!accountCounts[item.account]) {
        accountCounts[item.account] = { sent: 0, received: 0 }
      }
      accountCounts[item.account]!.sent = item.sent
    }

    // Add received counts
    for (const item of receivedCounts) {
      if (!accountCounts[item.account]) {
        accountCounts[item.account] = { sent: 0, received: 0 }
      }
      accountCounts[item.account]!.received = item.received
    }

    // Convert to array format
    const results = Object.entries(accountCounts).map(([account, counts]) => ({
      account,
      sent: counts.sent,
      received: counts.received,
    }))

    return c.json({ attestationCounts: results })
  } catch (error) {
    console.error('Error fetching attestation counts:', error)
    return c.json({ error: 'Failed to fetch attestation counts' }, 500)
  }
})

// Get attestation counts for a specific account
app.get('/counts/:account', async (c) => {
  try {
    const account = c.req.param('account')

    if (!account) {
      return c.json({ error: 'Account parameter is required' }, 400)
    }

    // Get sent count
    const sentResult = await db
      .select({ count: count(easAttestation.uid) })
      .from(easAttestation)
      .where(
        and(
          eq(easAttestation.attester, account as `0x${string}`),
          // not revoked
          eq(easAttestation.revocationTime, 0n),
          // not self-attested
          ne(easAttestation.attester, easAttestation.recipient)
        )
      )

    // Get received count
    const receivedResult = await db
      .select({ count: count(easAttestation.uid) })
      .from(easAttestation)
      .where(
        and(
          eq(easAttestation.recipient, account as `0x${string}`),
          // not revoked
          eq(easAttestation.revocationTime, 0n),
          // not self-attested
          ne(easAttestation.attester, easAttestation.recipient)
        )
      )

    const sent = sentResult[0]?.count || 0
    const received = receivedResult[0]?.count || 0

    return c.json({
      account,
      sent,
      received,
    })
  } catch (error) {
    console.error('Error fetching attestation counts for account:', error)
    return c.json({ error: 'Failed to fetch attestation counts' }, 500)
  }
})

// Get individual attestation by UID (must come after specific routes)
app.get('/:uid', async (c) => {
  try {
    const uid = c.req.param('uid') as `0x${string}`

    if (!uid) {
      return c.json({ error: 'UID parameter is required' }, 400)
    }

    const attestation = await db
      .select()
      .from(easAttestation)
      .where(eq(easAttestation.uid, uid))
      .limit(1)

    if (attestation.length === 0) {
      return c.json({ error: 'Attestation not found' }, 404)
    }

    return c.json(attestation[0])
  } catch (error) {
    console.error('Error fetching attestation:', error)
    return c.json({ error: 'Failed to fetch attestation' }, 500)
  }
})

export default app
