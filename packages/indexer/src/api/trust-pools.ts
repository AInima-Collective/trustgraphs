/**
 * TrustPools: the governor proposals a pool can vote on, and its members' casts.
 *
 * Routes:
 *   GET /trust-pools/:pool                         the pool and its governor's proposals, newest
 *                                                  first, each with the pool's own tally
 *   GET /trust-pools/:pool/proposals/:proposalId   one proposal and its members' votes
 *
 * Every bigint arrives as a decimal string. Status, governor-wide tallies, quorum and voting power
 * are not indexed: the client reads them live from the governor.
 */
import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from 'ponder:api'
import { trustPool, trustPoolProposal, trustPoolVote } from 'ponder:schema'
import { type Hex, isAddress } from 'viem'

import { type PoolTally, tallyPoolCasts } from '../trust-pool-shared'

const app = new Hono()

const MAX_PROPOSALS = 200

type ProposalRow = typeof trustPoolProposal.$inferSelect
type VoteRow = typeof trustPoolVote.$inferSelect

const EMPTY_TALLY: PoolTally = { against: 0n, for: 0n, abstain: 0n, voters: 0 }

const serializeProposal = (row: ProposalRow, tally = EMPTY_TALLY) => ({
  proposalId: row.proposalId.toString(),
  proposer: row.proposer,
  description: row.description,
  voteStart: row.voteStart.toString(),
  voteEnd: row.voteEnd.toString(),
  created: {
    block: row.blockNumber.toString(),
    timestamp: row.timestamp.toString(),
    txHash: row.txHash,
  },
  pool: {
    against: tally.against.toString(),
    for: tally.for.toString(),
    abstain: tally.abstain.toString(),
    voters: tally.voters,
  },
})

const serializeVote = (row: VoteRow) => ({
  voter: row.voter,
  support: row.support,
  score: row.score.toString(),
  weight: row.weight.toString(),
  reason: row.reason,
  block: row.blockNumber.toString(),
  timestamp: row.timestamp.toString(),
  txHash: row.txHash,
})

const findPool = async (raw: string) => {
  if (!isAddress(raw)) return undefined
  const [pool] = await db
    .select()
    .from(trustPool)
    .where(eq(trustPool.address, raw.toLowerCase() as Hex))
    .limit(1)
  return pool
}

app.get('/:pool', async (c) => {
  const pool = await findPool(c.req.param('pool'))
  if (!pool) return c.json({ error: 'Trust pool not found' }, 404)

  const [proposals, votes] = await Promise.all([
    db
      .select()
      .from(trustPoolProposal)
      .where(eq(trustPoolProposal.governor, pool.governor))
      .orderBy(desc(trustPoolProposal.blockNumber))
      .limit(MAX_PROPOSALS),
    db.select().from(trustPoolVote).where(eq(trustPoolVote.pool, pool.address)),
  ])
  const tallies = tallyPoolCasts(votes)
  return c.json({
    address: pool.address,
    snapshot: pool.snapshot,
    governor: pool.governor,
    proposals: proposals.map((row) =>
      serializeProposal(row, tallies.get(row.proposalId))
    ),
  })
})

app.get('/:pool/proposals/:proposalId', async (c) => {
  const raw = c.req.param('proposalId')
  if (!/^\d{1,78}$/.test(raw)) {
    return c.json({ error: 'proposalId must be a decimal uint256' }, 400)
  }
  const proposalId = BigInt(raw)
  const pool = await findPool(c.req.param('pool'))
  if (!pool) return c.json({ error: 'Trust pool not found' }, 404)

  const [[proposal], votes] = await Promise.all([
    db
      .select()
      .from(trustPoolProposal)
      .where(
        and(
          eq(trustPoolProposal.governor, pool.governor),
          eq(trustPoolProposal.proposalId, proposalId)
        )
      )
      .limit(1),
    db
      .select()
      .from(trustPoolVote)
      .where(
        and(
          eq(trustPoolVote.pool, pool.address),
          eq(trustPoolVote.proposalId, proposalId)
        )
      )
      .orderBy(desc(trustPoolVote.blockNumber)),
  ])
  if (!proposal) return c.json({ error: 'Proposal not found' }, 404)
  return c.json({
    proposal: serializeProposal(
      proposal,
      tallyPoolCasts(votes).get(proposalId)
    ),
    votes: votes.map(serializeVote),
  })
})

export default app
