/**
 * Authenticated, content-free API for the `nostr-workspace` program.
 *
 * The API exposes proven roots, member/agent identities, owner provenance, bindings, scores, and
 * Merkle proofs. It never reads or returns event bodies. Archive provenance is the redacted
 * commitment/availability view written only after ingestion reproduced the proven root and
 * skippedDigest.
 */
import { count, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { type Hex, isHex } from 'viem'

import * as offchainSchema from '../../offchain.schema'
import type { ScoreProgramProvenance } from '../score-program'
import { offchainDb } from './db'
import {
  type ScoreRow,
  buildScoreBundle,
  buildTree,
  leafSet,
  nodeOutputLeaf,
  proofFor,
} from './hypercerts-tree'
import { nostrPage } from './nostr-workspace-api-shared'
import {
  ScoreProgramApiError,
  requireEntryScoreProgram,
  requireRowScoreProgram,
  requireSnapshotScoreProgram,
} from './score-programs'
import { lower } from './utils'

declare global {
  interface BigInt {
    toJSON: () => string
  }
}
BigInt.prototype.toJSON = function () {
  return this.toString()
}

const app = new Hono()
const address = (value: string) =>
  isHex(value) && value.length === 42 ? value.toLowerCase() : null
const bytes32 = (value: string) =>
  isHex(value) && value.length === 66 ? (value.toLowerCase() as Hex) : null

const metadataFor = async (snapshot: string, root: string) =>
  offchainDb.query.nostrWorkspaceMetadata.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(lower(table.merkleSnapshotContract), snapshot.toLowerCase()),
        eq(lower(table.root), root.toLowerCase())
      ),
  })

const latestMetadata = async (snapshot: string) =>
  offchainDb.query.nostrWorkspaceMetadata.findFirst({
    where: (table, { eq }) =>
      eq(lower(table.merkleSnapshotContract), snapshot.toLowerCase()),
    orderBy: (table, { desc }) => desc(table.timestamp),
  })

const resolveRoot = async (snapshot: string, raw: string) => {
  if (raw === 'current') {
    const current = await latestMetadata(snapshot)
    return current?.root ?? null
  }
  const root = bytes32(raw)
  if (!root) return null
  return (await metadataFor(snapshot, root))?.root ?? null
}

const authenticateMetadata = async (
  row: typeof offchainSchema.nostrWorkspaceMetadata.$inferSelect
) => {
  const current = await requireSnapshotScoreProgram(
    row.merkleSnapshotContract,
    'nostr-workspace'
  )
  return requireRowScoreProgram(row, current, 'nostr-workspace')
}

const loadAllScores = async (
  snapshot: string,
  root: string,
  scoreProgram: ScoreProgramProvenance
) => {
  const rows = await offchainDb.query.nostrWorkspaceScore.findMany({
    where: (table, { and, eq }) =>
      and(
        eq(lower(table.merkleSnapshotContract), snapshot.toLowerCase()),
        eq(lower(table.root), root.toLowerCase())
      ),
  })
  for (const row of rows) requireEntryScoreProgram(row, scoreProgram)
  return rows
}

/** Rebuild the exact unified nodeId + optional bound-address tree before serving any proof. */
const reconstructRoot = (
  rows: (typeof offchainSchema.nostrWorkspaceScore.$inferSelect)[],
  expected: string
) => {
  const scores: ScoreRow[] = rows.map((row) => ({
    nodeId: row.nodeId as Hex,
    value: row.value,
    boundAddress: (row.boundAddress as Hex | null) ?? null,
  }))
  const tree = buildTree(leafSet(scores))
  if (!tree[0] || tree[0].toLowerCase() !== expected.toLowerCase()) {
    throw new ScoreProgramApiError(
      'indexed Nostr score/binding set does not reproduce the proven root'
    )
  }
  return { scores, tree }
}

const metadataView = (
  row: typeof offchainSchema.nostrWorkspaceMetadata.$inferSelect,
  scoreProgram: ScoreProgramProvenance
) => ({
  snapshot: row.merkleSnapshotContract,
  root: row.root,
  checkpointId: row.checkpointId,
  ipfsHash: row.ipfsHash,
  ipfsHashCid: row.ipfsHashCid,
  numNodes: row.numNodes,
  totalValue: row.totalValue,
  skippedDigest: row.skippedDigest,
  anchorAcc: row.anchorAcc,
  anchorCount: row.anchorCount,
  accessPolicy: row.accessPolicy,
  epochTrustClass: row.epochTrustClass,
  reducedRecomputeStatus: row.reducedRecomputeStatus,
  skipSummary: row.skipSummary,
  archiveProvenance: row.archiveProvenance,
  blockNumber: row.blockNumber,
  timestamp: row.timestamp,
  scoreProgram,
})

const scoreView = (
  row: typeof offchainSchema.nostrWorkspaceScore.$inferSelect,
  proof: Hex[]
) => ({
  nodeId: row.nodeId,
  nostrPubkey: row.nostrPubkey,
  actorKind: row.actorKind,
  ownerNodeId: row.ownerNodeId,
  boundAddress: row.boundAddress,
  value: row.value,
  proof,
})

// GET /nostr-workspace/roots?snapshot=0x..&limit=50&offset=0
app.get('/roots', async (c) => {
  const pagination = nostrPage(c.req.query('limit'), c.req.query('offset'))
  const snapshotRaw = c.req.query('snapshot')
  const snapshot = snapshotRaw ? address(snapshotRaw) : null
  if (!pagination || (snapshotRaw && !snapshot)) {
    return c.json({ error: 'invalid snapshot, limit, or offset' }, 400)
  }
  const where = snapshot
    ? eq(
        lower(offchainSchema.nostrWorkspaceMetadata.merkleSnapshotContract),
        snapshot
      )
    : undefined
  const [rows, totals] = await Promise.all([
    offchainDb
      .select()
      .from(offchainSchema.nostrWorkspaceMetadata)
      .where(where)
      .orderBy(desc(offchainSchema.nostrWorkspaceMetadata.timestamp))
      .limit(pagination.limit)
      .offset(pagination.offset),
    offchainDb
      .select({ value: count(offchainSchema.nostrWorkspaceMetadata.root) })
      .from(offchainSchema.nostrWorkspaceMetadata)
      .where(where),
  ])
  try {
    const roots = []
    for (const row of rows) {
      roots.push(metadataView(row, await authenticateMetadata(row)))
    }
    return c.json({
      roots,
      page: { ...pagination, total: totals[0]?.value ?? 0 },
    })
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return c.json({ error: error.message }, 409)
    }
    throw error
  }
})

const serveScores = async (
  snapshot: string,
  root: string,
  pagination: { limit: number; offset: number }
) => {
  const meta = await metadataFor(snapshot, root)
  if (!meta)
    return { status: 404 as const, body: { error: 'Nostr root not indexed' } }
  try {
    const scoreProgram = await authenticateMetadata(meta)
    const all = await loadAllScores(snapshot, root, scoreProgram)
    const { tree } = reconstructRoot(all, meta.root)
    const rows = await offchainDb.query.nostrWorkspaceScore.findMany({
      where: (table, { and, eq }) =>
        and(
          eq(lower(table.merkleSnapshotContract), snapshot.toLowerCase()),
          eq(lower(table.root), root.toLowerCase())
        ),
      orderBy: (table, { desc, asc }) => [desc(table.value), asc(table.nodeId)],
      limit: pagination.limit,
      offset: pagination.offset,
    })
    for (const row of rows) requireEntryScoreProgram(row, scoreProgram)
    return {
      status: 200 as const,
      body: {
        ...metadataView(meta, scoreProgram),
        scores: rows.map((row) => {
          const proof = proofFor(
            tree,
            nodeOutputLeaf(row.nodeId as Hex, row.value)
          )
          if (proof === null) {
            throw new ScoreProgramApiError(
              'indexed Nostr node is absent from its proven tree'
            )
          }
          return scoreView(row, proof)
        }),
        page: { ...pagination, total: all.length },
      },
    }
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return { status: 409 as const, body: { error: error.message } }
    }
    throw error
  }
}

const serveBundle = async (snapshot: string, root: string, nodeId: Hex) => {
  const meta = await metadataFor(snapshot, root)
  if (!meta)
    return { status: 404 as const, body: { error: 'Nostr root not indexed' } }
  try {
    const scoreProgram = await authenticateMetadata(meta)
    const all = await loadAllScores(snapshot, root, scoreProgram)
    reconstructRoot(all, meta.root)
    const target = all.find(
      (row) => row.nodeId.toLowerCase() === nodeId.toLowerCase()
    )
    if (!target)
      return { status: 404 as const, body: { error: 'Nostr node not scored' } }
    const bundle = buildScoreBundle(
      all.map((row) => ({
        nodeId: row.nodeId as Hex,
        value: row.value,
        boundAddress: (row.boundAddress as Hex | null) ?? null,
      })),
      nodeId
    )
    if (bundle.root.toLowerCase() !== meta.root.toLowerCase()) {
      throw new ScoreProgramApiError(
        'Nostr proof bundle conflicts with the proven root'
      )
    }
    return {
      status: 200 as const,
      body: {
        ...metadataView(meta, scoreProgram),
        score: scoreView(target, bundle.proof),
      },
    }
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return { status: 409 as const, body: { error: error.message } }
    }
    throw error
  }
}

// GET /nostr-workspace/:snapshot/scores?root=current&limit=50&offset=0
app.get('/:snapshot/scores', async (c) => {
  const snapshot = address(c.req.param('snapshot'))
  const pagination = nostrPage(c.req.query('limit'), c.req.query('offset'))
  if (!snapshot || !pagination)
    return c.json({ error: 'invalid snapshot or pagination' }, 400)
  const root = await resolveRoot(snapshot, c.req.query('root') ?? 'current')
  if (!root) return c.json({ error: 'Nostr root not indexed' }, 404)
  const result = await serveScores(snapshot, root, pagination)
  return c.json(result.body, result.status)
})

// GET /nostr-workspace/:snapshot/:root/scores?limit=50&offset=0
app.get('/:snapshot/:root/scores', async (c) => {
  const snapshot = address(c.req.param('snapshot'))
  const pagination = nostrPage(c.req.query('limit'), c.req.query('offset'))
  if (!snapshot || !pagination)
    return c.json({ error: 'invalid snapshot or pagination' }, 400)
  const root = await resolveRoot(snapshot, c.req.param('root'))
  if (!root) return c.json({ error: 'Nostr root not indexed' }, 404)
  const result = await serveScores(snapshot, root, pagination)
  return c.json(result.body, result.status)
})

// GET /nostr-workspace/:snapshot/score/:nodeId?root=current
app.get('/:snapshot/score/:nodeId', async (c) => {
  const snapshot = address(c.req.param('snapshot'))
  const nodeId = bytes32(c.req.param('nodeId'))
  if (!snapshot || !nodeId)
    return c.json({ error: 'invalid snapshot or nodeId' }, 400)
  const root = await resolveRoot(snapshot, c.req.query('root') ?? 'current')
  if (!root) return c.json({ error: 'Nostr root not indexed' }, 404)
  const result = await serveBundle(snapshot, root, nodeId)
  return c.json(result.body, result.status)
})

// GET /nostr-workspace/:snapshot/:root/score/:nodeId
app.get('/:snapshot/:root/score/:nodeId', async (c) => {
  const snapshot = address(c.req.param('snapshot'))
  const nodeId = bytes32(c.req.param('nodeId'))
  if (!snapshot || !nodeId)
    return c.json({ error: 'invalid snapshot or nodeId' }, 400)
  const root = await resolveRoot(snapshot, c.req.param('root'))
  if (!root) return c.json({ error: 'Nostr root not indexed' }, 404)
  const result = await serveBundle(snapshot, root, nodeId)
  return c.json(result.body, result.status)
})

export default app
