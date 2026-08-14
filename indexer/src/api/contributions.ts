/**
 * Contributions-program API (GOAL.md M3; research/CONTRIBUTION_FUNDING.md §3, §5).
 *
 * Serves the round view, claims-with-scores, per-claim score detail, per-account payout bundles
 * (`{value, proof[]}` — the merkleEntry shape the claim UI consumes), and the honest-UI audit view
 * (why each live valuation counted, was discounted, or was filtered). Convenience over the
 * canonical interface, never a second source of truth: every derived number comes from
 * `ingestContributionsScores` (src/contributions.ts), which only publishes rows after its full
 * recompute reproduced the PROVEN on-chain root. An unverified round answers 409 here — we refuse
 * to serve numbers we could not validate.
 *
 * Routes ("current" is accepted wherever :root appears; :snapshot may be omitted via the
 * query-less shorthands when the box runs a single contributions instance):
 *   GET /contributions/rounds?snapshot=0x…                 known rounds (newest first)
 *   GET /contributions/round?snapshot=0x…&root=…           round summary (window/pool/root/cid/status)
 *   GET /contributions/claims?snapshot=0x…&root=…          claims list with live decoded data + scores
 *   GET /contributions/:snapshot/score/:claimUID           score detail at the current root
 *   GET /contributions/:snapshot/:root/score/:claimUID     …at an explicit root
 *   GET /contributions/:snapshot/payout/:account           payout bundle at the current root
 *   GET /contributions/:snapshot/:root/payout/:account     …at an explicit root
 *   GET /contributions/:snapshot/audit/:claimUID           audit view at the current root
 *   GET /contributions/:snapshot/:root/audit/:claimUID     …at an explicit root
 */
import { asc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from 'ponder:api'
import {
  contributionClaim,
  contributionClaimContributor,
  contributionResponse,
  contributionValuation,
} from 'ponder:schema'
import { type Hex } from 'viem'

import { offchainDb } from './db'
import {
  ScoreProgramApiError,
  requireRowScoreProgram,
  requireSnapshotScoreProgram,
} from './score-programs'
import { lower } from './utils'
import * as offchainSchema from '../../offchain.schema'
import {
  CONTRIBUTIONS_INSTANCES,
  contributionsInstanceForSnapshot,
} from '../contributions-shared'
import {
  SCORE_OUTPUT_DOMAIN_IDS,
  requireScoreKeyDomain,
} from '../score-program'

declare global {
  interface BigInt {
    toJSON: () => string
  }
}
BigInt.prototype.toJSON = function () {
  return this.toString()
}

const app = new Hono()

const contributionClaimDomain = requireScoreKeyDomain(
  SCORE_OUTPUT_DOMAIN_IDS['contributions-claim-v1'],
  'contributions'
)
const serializedClaimDomain = {
  outputDomain: contributionClaimDomain.id,
  outputDomainName: contributionClaimDomain.name,
  keyEncoding: contributionClaimDomain.keyEncoding,
}

const requireClaimRow = (
  row: { programId: string | null; outputDomain: string | null },
  scoreProgram: Awaited<ReturnType<typeof requireSnapshotScoreProgram>>
) => {
  if (
    !row.programId ||
    !row.outputDomain ||
    row.programId.toLowerCase() !== scoreProgram.programId.toLowerCase()
  ) {
    throw new ScoreProgramApiError(
      'contributions claim row has an unknown or mismatched program discriminator'
    )
  }
  let domain
  try {
    domain = requireScoreKeyDomain(row.outputDomain, 'contributions')
  } catch (error) {
    throw new ScoreProgramApiError(
      error instanceof Error ? error.message : String(error)
    )
  }
  if (domain.name !== 'contributions-claim-v1') {
    throw new ScoreProgramApiError(
      `contributions claim row uses ${domain.name}, expected contributions-claim-v1`
    )
  }
}

const requireRecipientRow = (
  row: { programId: string | null; outputDomain: string | null },
  scoreProgram: Awaited<ReturnType<typeof requireSnapshotScoreProgram>>
) => {
  if (
    !row.programId ||
    !row.outputDomain ||
    row.programId.toLowerCase() !== scoreProgram.programId.toLowerCase() ||
    row.outputDomain.toLowerCase() !== scoreProgram.outputDomain.toLowerCase()
  ) {
    throw new ScoreProgramApiError(
      'contributions payout row has an unknown or mismatched program/output domain'
    )
  }
}

type RoundRow = typeof offchainSchema.contributionRound.$inferSelect
type ResolvedRound = RoundRow & {
  scoreProgram: Awaited<ReturnType<typeof requireSnapshotScoreProgram>>
}

/** The latest round row, optionally scoped to one snapshot contract. */
const latestRound = async (snapshot?: string) =>
  offchainDb.query.contributionRound.findFirst({
    where: snapshot
      ? (t, { eq }) =>
          eq(lower(t.merkleSnapshotContract), snapshot.toLowerCase())
      : undefined,
    orderBy: (t, { desc }) => desc(t.timestamp),
  })

/** Resolve the snapshot: explicit param, else the box's single contributions instance. */
const resolveSnapshot = (snapshotQ?: string): string | null => {
  if (snapshotQ) return snapshotQ
  const only =
    CONTRIBUTIONS_INSTANCES.length === 1
      ? CONTRIBUTIONS_INSTANCES[0]
      : undefined
  return only?.contracts?.merkleSnapshot ?? null
}

/** Resolve `root` ("current" ⇒ latest round row) for a snapshot. Throws if not found. */
const resolveRound = async (
  snapshot: string,
  root: string
): Promise<ResolvedRound> => {
  const row =
    root === 'current'
      ? await latestRound(snapshot)
      : await offchainDb.query.contributionRound.findFirst({
          where: (t, { and, eq }) =>
            and(
              eq(lower(t.merkleSnapshotContract), snapshot.toLowerCase()),
              eq(lower(t.root), root.toLowerCase())
            ),
        })
  if (!row) throw new Error('No contributions round found for this root')
  const current = await requireSnapshotScoreProgram(snapshot, 'contributions')
  return {
    ...row,
    scoreProgram: requireRowScoreProgram(row, current, 'contributions'),
  }
}

/** 409 body for a round whose display recompute could not reproduce the proven root. */
const unverifiedBody = (round: ResolvedRound) => ({
  error:
    'The indexed data for this round does not reproduce the proven on-chain root; refusing to serve derived scores',
  failureReason: round.failureReason,
  root: round.root,
  snapshot: round.merkleSnapshotContract,
  scoreProgram: round.scoreProgram,
})

/** Round status from the window vs now (plain-language lifecycle for the UI). */
const roundStatus = (
  round: Pick<RoundRow, 'roundStart' | 'roundEnd'>
): 'upcoming' | 'open' | 'closed' | 'unknown' => {
  if (round.roundStart === null || round.roundEnd === null) return 'unknown'
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (now < round.roundStart) return 'upcoming'
  if (now <= round.roundEnd) return 'open'
  return 'closed'
}

const roundSummary = (round: ResolvedRound) => ({
  snapshot: round.merkleSnapshotContract,
  root: round.root,
  checkpointId: round.checkpointId,
  ipfsHash: round.ipfsHash,
  ipfsHashCid: round.ipfsHashCid,
  status: roundStatus(round),
  verified: round.verified,
  failureReason: round.failureReason,
  roundStart: round.roundStart,
  roundEnd: round.roundEnd,
  totalPool: round.totalPool,
  totalValue: round.totalValue,
  numClaims: round.numClaims,
  numRecipients: round.numRecipients,
  params: round.params,
  trustAcc: round.trustAcc,
  trustLeafCount: round.trustLeafCount,
  anchorAcc: round.anchorAcc,
  anchorCount: round.anchorCount,
  paramsHash: round.paramsHash,
  blockNumber: round.blockNumber,
  timestamp: round.timestamp,
  scoreProgram: round.scoreProgram,
})

// GET /contributions/rounds — discovery: known rounds (newest first), optionally per snapshot.
app.get('/rounds', async (c) => {
  const snapshot = c.req.query('snapshot')
  const rows = await offchainDb.query.contributionRound.findMany({
    where: snapshot
      ? (t, { eq }) =>
          eq(lower(t.merkleSnapshotContract), snapshot.toLowerCase())
      : undefined,
    orderBy: (t, { desc }) => desc(t.timestamp),
  })
  try {
    const authenticated = await Promise.all(
      rows.map(async (row) => {
        const current = await requireSnapshotScoreProgram(
          row.merkleSnapshotContract,
          'contributions'
        )
        return {
          ...row,
          scoreProgram: requireRowScoreProgram(row, current, 'contributions'),
        }
      })
    )
    return c.json({ rounds: authenticated.map(roundSummary) })
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return c.json({ error: error.message }, 409)
    }
    throw error
  }
})

// GET /contributions/round — the round summary at the current (or ?root=) root.
app.get('/round', async (c) => {
  const snapshot = resolveSnapshot(c.req.query('snapshot'))
  if (!snapshot) {
    return c.json(
      { error: 'snapshot is required (no single contributions instance)' },
      400
    )
  }
  try {
    const round = await resolveRound(snapshot, c.req.query('root') ?? 'current')
    return c.json(roundSummary(round))
  } catch (e: any) {
    return c.json(
      { error: e.message },
      e instanceof ScoreProgramApiError ? 409 : 404
    )
  }
})

// Path-style alias — the shape the frontend's contributions-api client fetches
// (`/contributions/:snapshot/round`), mirroring the :snapshot param routes below (M5).
app.get('/:snapshot/round', async (c) => {
  const { snapshot } = c.req.param()
  try {
    const round = await resolveRound(snapshot, c.req.query('root') ?? 'current')
    return c.json(roundSummary(round))
  } catch (e: any) {
    return c.json(
      { error: e.message },
      e instanceof ScoreProgramApiError ? 409 : 404
    )
  }
})

/** Claims list: live decoded claims for the instance's resolver + scores at the resolved root. */
const serveClaims = async (snapshot: string, rootQ: string) => {
  let currentScoreProgram
  try {
    currentScoreProgram = await requireSnapshotScoreProgram(
      snapshot,
      'contributions'
    )
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return { status: 409 as const, body: { error: error.message } }
    }
    throw error
  }
  const instance = contributionsInstanceForSnapshot(snapshot)
  if (!instance) {
    return {
      status: 404 as const,
      body: { error: 'No contributions instance for this snapshot' },
    }
  }
  const resolver = instance.contracts!.contributionResolver!.toLowerCase()

  // The round is optional here: before any proven root the claims list still serves the live
  // attested state (scores null). An unverified round serves claims but refuses its scores.
  let round: ResolvedRound | null = null
  try {
    round = await resolveRound(snapshot, rootQ)
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return { status: 409 as const, body: { error: error.message } }
    }
    if (rootQ !== 'current') {
      return {
        status: 404 as const,
        body: { error: 'No contributions round found for this root' },
      }
    }
  }

  const claims = await db
    .select()
    .from(contributionClaim)
    .where(eq(contributionClaim.resolver, resolver as Hex))
    .orderBy(asc(contributionClaim.blockTimestamp))

  const uids = claims.map((cl) => cl.uid)
  const contributors =
    uids.length > 0
      ? await db
          .select()
          .from(contributionClaimContributor)
          .where(inArray(contributionClaimContributor.claimUid, uids))
      : []
  const responses =
    uids.length > 0
      ? await db
          .select()
          .from(contributionResponse)
          .where(inArray(contributionResponse.claimUid, uids))
      : []
  const valuations =
    uids.length > 0
      ? await db
          .select()
          .from(contributionValuation)
          .where(inArray(contributionValuation.claimUid, uids))
      : []

  const scores =
    round && round.verified
      ? await offchainDb.query.contributionScore.findMany({
          where: (t, { and, eq }) =>
            and(
              eq(lower(t.merkleSnapshotContract), snapshot.toLowerCase()),
              eq(lower(t.root), round!.root.toLowerCase())
            ),
        })
      : []
  try {
    for (const score of scores) requireClaimRow(score, round!.scoreProgram)
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return { status: 409 as const, body: { error: error.message } }
    }
    throw error
  }
  const scoreByUid = new Map(scores.map((s) => [s.claimUid.toLowerCase(), s]))

  const body = {
    snapshot,
    root: round?.root ?? null,
    verified: round?.verified ?? null,
    roundStart: round?.roundStart ?? null,
    roundEnd: round?.roundEnd ?? null,
    scoreProgram: round?.scoreProgram ?? currentScoreProgram,
    scoreKeyDomain: serializedClaimDomain,
    claims: claims
      .map((cl) => {
        const uid = cl.uid.toLowerCase()
        const score = scoreByUid.get(uid)
        return {
          uid: cl.uid,
          title: cl.title,
          uri: cl.uri,
          contentHash: cl.contentHash,
          attester: cl.attester,
          malformed: cl.malformed,
          revoked: cl.revoked,
          blockTimestamp: cl.blockTimestamp,
          contributors: contributors
            .filter((row) => row.claimUid.toLowerCase() === uid)
            .map((row) => ({
              contributor: row.contributor,
              share: row.share,
            })),
          responses: responses
            .filter(
              (r) =>
                r.claimUid?.toLowerCase() === uid &&
                !r.revoked &&
                !r.malformed &&
                !r.superseded
            )
            .map((r) => ({ responder: r.responder, response: r.response })),
          liveValuations: valuations.filter(
            (v) =>
              v.claimUid?.toLowerCase() === uid &&
              !v.revoked &&
              !v.malformed &&
              !v.superseded
          ).length,
          // S(c) + per-contributor payout breakdown, only present at a verified root.
          scoreFp: score?.scoreFp ?? null,
          breakdown: score?.contributors ?? null,
        }
      })
      .sort((a, b) => {
        const sa = a.scoreFp ?? -1n
        const sb = b.scoreFp ?? -1n
        return sb > sa ? 1 : sb < sa ? -1 : 0
      }),
  }
  return { status: 200 as const, body }
}

// GET /contributions/claims — claims + scores at the current (or ?root=) root.
app.get('/claims', async (c) => {
  const snapshot = resolveSnapshot(c.req.query('snapshot'))
  if (!snapshot) {
    return c.json(
      { error: 'snapshot is required (no single contributions instance)' },
      400
    )
  }
  const res = await serveClaims(snapshot, c.req.query('root') ?? 'current')
  return c.json(res.body as object, res.status)
})

// Path-style alias — the frontend client's `/contributions/:snapshot/claims` shape (M5).
app.get('/:snapshot/claims', async (c) => {
  const { snapshot } = c.req.param()
  const res = await serveClaims(snapshot, c.req.query('root') ?? 'current')
  return c.json(res.body as object, res.status)
})

/** Score detail for one claim at a resolved round (409 when the round failed verification). */
const serveScore = async (
  snapshot: string,
  rootQ: string,
  claimUid: string
) => {
  let round: ResolvedRound
  try {
    round = await resolveRound(snapshot, rootQ)
  } catch (e: any) {
    return {
      status: (e instanceof ScoreProgramApiError ? 409 : 404) as 404 | 409,
      body: { error: e.message },
    }
  }
  if (!round.verified) {
    return { status: 409 as const, body: unverifiedBody(round) }
  }

  const score = await offchainDb.query.contributionScore.findFirst({
    where: (t, { and, eq }) =>
      and(
        eq(lower(t.merkleSnapshotContract), snapshot.toLowerCase()),
        eq(lower(t.root), round.root.toLowerCase()),
        eq(lower(t.claimUid), claimUid.toLowerCase())
      ),
  })
  if (!score) {
    return {
      status: 404 as const,
      body: { error: 'No score for this claim at this root' },
    }
  }
  try {
    requireClaimRow(score, round.scoreProgram)
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return { status: 409 as const, body: { error: error.message } }
    }
    throw error
  }

  const audit = await offchainDb.query.contributionValuationAudit.findMany({
    where: (t, { and, eq }) =>
      and(
        eq(lower(t.merkleSnapshotContract), snapshot.toLowerCase()),
        eq(lower(t.root), round.root.toLowerCase()),
        eq(lower(t.claimUid), claimUid.toLowerCase())
      ),
    orderBy: (t, { asc }) => asc(t.rater),
  })
  try {
    for (const row of audit) requireClaimRow(row, round.scoreProgram)
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return { status: 409 as const, body: { error: error.message } }
    }
    throw error
  }

  const [claim] = await db
    .select()
    .from(contributionClaim)
    .where(eq(contributionClaim.uid, claimUid.toLowerCase() as Hex))

  return {
    status: 200 as const,
    body: {
      snapshot,
      root: round.root,
      claimUid: claimUid.toLowerCase(),
      scoreProgram: round.scoreProgram,
      scoreKeyDomain: serializedClaimDomain,
      scoreFp: score.scoreFp,
      breakdown: score.contributors,
      valuations: audit.map((a) => ({
        rater: a.rater,
        score: a.score,
        status: a.status,
        reason: a.reason,
        discountFp: a.discountFp,
        raterRepFp: a.raterRepFp,
      })),
      claim: claim
        ? {
            title: claim.title,
            uri: claim.uri,
            contentHash: claim.contentHash,
            attester: claim.attester,
            revoked: claim.revoked,
            blockTimestamp: claim.blockTimestamp,
          }
        : null,
    },
  }
}

app.get('/:snapshot/score/:claimUid', async (c) => {
  const { snapshot, claimUid } = c.req.param()
  const res = await serveScore(snapshot, 'current', claimUid)
  return c.json(res.body as object, res.status)
})

app.get('/:snapshot/:root/score/:claimUid', async (c) => {
  const { snapshot, root, claimUid } = c.req.param()
  const res = await serveScore(snapshot, root, claimUid)
  return c.json(res.body as object, res.status)
})

/**
 * Payout bundle: the `{value, proof[]}` merkle entry the claim UI feeds to
 * `MerkleFundDistributor.claim`. Entries come from the generic root-validated ingestion
 * (src/merkle.ts — proofs only exist when the rebuilt tree reproduced the on-chain root), so a
 * served proof always verifies on-chain; `verified` reports the score-recompute verdict.
 */
const servePayout = async (
  snapshot: string,
  rootQ: string,
  account: string
) => {
  let round: ResolvedRound
  try {
    round = await resolveRound(snapshot, rootQ)
  } catch (e: any) {
    return {
      status: (e instanceof ScoreProgramApiError ? 409 : 404) as 404 | 409,
      body: { error: e.message },
    }
  }

  const entry = await offchainDb.query.merkleEntry.findFirst({
    columns: {
      account: true,
      value: true,
      proof: true,
      programId: true,
      outputDomain: true,
    },
    where: (t, { and, eq }) =>
      and(
        eq(lower(t.merkleSnapshotContract), snapshot.toLowerCase()),
        eq(lower(t.root), round.root.toLowerCase()),
        eq(lower(t.account), account.toLowerCase())
      ),
  })
  if (!entry) {
    return {
      status: 404 as const,
      body: { error: 'No payout for this account at this root' },
    }
  }
  try {
    requireRecipientRow(entry, round.scoreProgram)
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return { status: 409 as const, body: { error: error.message } }
    }
    throw error
  }

  return {
    status: 200 as const,
    body: {
      snapshot,
      root: round.root,
      ipfsHash: round.ipfsHash,
      ipfsHashCid: round.ipfsHashCid,
      totalValue: round.totalValue,
      verified: round.verified,
      scoreProgram: round.scoreProgram,
      account: entry.account,
      value: entry.value,
      proof: entry.proof,
    },
  }
}

app.get('/:snapshot/payout/:account', async (c) => {
  const { snapshot, account } = c.req.param()
  const res = await servePayout(snapshot, 'current', account)
  return c.json(res.body as object, res.status)
})

app.get('/:snapshot/:root/payout/:account', async (c) => {
  const { snapshot, root, account } = c.req.param()
  const res = await servePayout(snapshot, root, account)
  return c.json(res.body as object, res.status)
})

/**
 * Audit view for one claim: every live valuation with its verdict — counted at full weight,
 * collaborator-discounted (with the discount), or filtered ('selfValuation' | 'belowMinRep') —
 * the §5 anti-gaming table made visible so UI copy can be honest about what counted.
 */
const serveAudit = async (
  snapshot: string,
  rootQ: string,
  claimUid: string
) => {
  let round: ResolvedRound
  try {
    round = await resolveRound(snapshot, rootQ)
  } catch (e: any) {
    return {
      status: (e instanceof ScoreProgramApiError ? 409 : 404) as 404 | 409,
      body: { error: e.message },
    }
  }
  if (!round.verified) {
    return { status: 409 as const, body: unverifiedBody(round) }
  }

  const audit = await offchainDb.query.contributionValuationAudit.findMany({
    where: (t, { and, eq }) =>
      and(
        eq(lower(t.merkleSnapshotContract), snapshot.toLowerCase()),
        eq(lower(t.root), round.root.toLowerCase()),
        eq(lower(t.claimUid), claimUid.toLowerCase())
      ),
    orderBy: (t, { asc }) => asc(t.rater),
  })
  try {
    for (const row of audit) requireClaimRow(row, round.scoreProgram)
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return { status: 409 as const, body: { error: error.message } }
    }
    throw error
  }

  return {
    status: 200 as const,
    body: {
      snapshot,
      root: round.root,
      claimUid: claimUid.toLowerCase(),
      scoreProgram: round.scoreProgram,
      scoreKeyDomain: serializedClaimDomain,
      valuations: audit.map((a) => ({
        rater: a.rater,
        score: a.score,
        status: a.status,
        reason: a.reason,
        discountFp: a.discountFp,
        raterRepFp: a.raterRepFp,
      })),
    },
  }
}

app.get('/:snapshot/audit/:claimUid', async (c) => {
  const { snapshot, claimUid } = c.req.param()
  const res = await serveAudit(snapshot, 'current', claimUid)
  return c.json(res.body as object, res.status)
})

app.get('/:snapshot/:root/audit/:claimUid', async (c) => {
  const { snapshot, root, claimUid } = c.req.param()
  const res = await serveAudit(snapshot, root, claimUid)
  return c.json(res.body as object, res.status)
})

export default app
