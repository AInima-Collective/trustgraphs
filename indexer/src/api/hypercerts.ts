/**
 * Hypercerts score-bundle API (HYPERCERTS_ATPROTO_PLAN §10.3).
 *
 * Serves `{nodeId, score, proof[]}` bundles so Hypercerts' apps get ranking + a merkle proof against
 * the on-chain `outputRoot` WITHOUT running any infrastructure (no prover, no CAR archive, no tree
 * builder). This is a convenience over the canonical interface (the on-chain root + proofs), never a
 * second source of truth: every bundle carries the proof and root, so a consumer can verify it against
 * the chain and ignore this endpoint entirely.
 *
 * Data source: the `offchain.hypercerts_metadata` + `offchain.hypercerts_score` tables (the lane-2
 * twins of `merkle_metadata`/`merkle_entry`). Their ingestion is the off-chain prover/witness pipeline
 * (`ingestHypercertsScores` in ../anchor.ts), stubbed for now — so with no live rows these routes 404;
 * the proof-construction logic is verified independently by src/api/hypercerts-tree.test.ts.
 *
 * The proof is rebuilt with the guest's exact OZ StandardMerkleTree over the SAME leaf set the guest
 * emits (unified nodeId leaves for every scored node + v1 address leaves for bound nodes) — see
 * hypercerts-tree.ts. If a precomputed `proof` column is present it is served directly; otherwise the
 * tree is rebuilt from the root's full score set. Either way the recomputed root is cross-checked
 * against the stored on-chain root before serving.
 *
 * Routes:
 *   GET /hypercerts/roots?snapshot=0x..        list known roots (newest first) for a snapshot (or all)
 *   GET /hypercerts/score/:nodeId               bundle at the current root of the (single) instance
 *   GET /hypercerts/:snapshot/score/:nodeId     bundle at that snapshot's current root
 *   GET /hypercerts/:snapshot/:root/score/:nodeId   bundle at an explicit root ("current" allowed)
 */
import { Hono } from 'hono'
import { type Hex } from 'viem'

import { offchainDb } from './db'
import { type ScoreRow, buildScoreBundle } from './hypercerts-tree'
import { lower } from './utils'

declare global {
  interface BigInt {
    toJSON: () => string
  }
}
BigInt.prototype.toJSON = function () {
  return this.toString()
}

const hypercertsApp = new Hono()

/** The current (latest) hypercerts metadata row, optionally scoped to one snapshot contract. */
const latestMetadata = async (snapshot?: string) =>
  offchainDb.query.hypercertsMetadata.findFirst({
    where: snapshot
      ? (t, { eq }) =>
          eq(lower(t.merkleSnapshotContract), snapshot.toLowerCase())
      : undefined,
    orderBy: (t, { desc }) => desc(t.timestamp),
  })

/** Resolve `root` to a concrete on-chain root for a snapshot ("current" ⇒ latest). Throws if missing. */
const resolveRoot = async (snapshot: string, root: string): Promise<string> => {
  if (root === 'current') {
    const meta = await latestMetadata(snapshot)
    if (!meta) throw new Error('No hypercerts root found for snapshot')
    return meta.root
  }
  const meta = await offchainDb.query.hypercertsMetadata.findFirst({
    where: (t, { eq, and }) =>
      and(
        eq(lower(t.merkleSnapshotContract), snapshot.toLowerCase()),
        eq(lower(t.root), root.toLowerCase())
      ),
  })
  if (!meta) throw new Error('Hypercerts root not found')
  return root
}

/** Load the full score set for a (snapshot, root) as the tree-builder's row shape. */
const loadScores = async (
  snapshot: string,
  root: string
): Promise<ScoreRow[]> => {
  const rows = await offchainDb.query.hypercertsScore.findMany({
    columns: { nodeId: true, value: true, boundAddress: true },
    where: (t, { eq, and }) =>
      and(
        eq(lower(t.merkleSnapshotContract), snapshot.toLowerCase()),
        eq(lower(t.root), root.toLowerCase())
      ),
  })
  return rows.map((r) => ({
    nodeId: r.nodeId as Hex,
    value: r.value,
    boundAddress: (r.boundAddress as Hex | null) ?? null,
  }))
}

/** Assemble + serve the bundle for one node at a resolved (snapshot, root). */
const serveBundle = async (
  snapshot: string,
  root: string,
  nodeId: string
): Promise<{ status: 200 | 404 | 409; body: unknown }> => {
  const meta = await offchainDb.query.hypercertsMetadata.findFirst({
    where: (t, { eq, and }) =>
      and(
        eq(lower(t.merkleSnapshotContract), snapshot.toLowerCase()),
        eq(lower(t.root), root.toLowerCase())
      ),
  })
  if (!meta)
    return { status: 404, body: { error: 'Hypercerts root not found' } }

  const scores = await loadScores(snapshot, root)
  if (scores.length === 0) {
    return { status: 404, body: { error: 'No scores indexed for this root' } }
  }

  let bundle
  try {
    bundle = buildScoreBundle(scores, nodeId as Hex)
  } catch {
    return { status: 404, body: { error: 'nodeId not present in this root' } }
  }

  // Convenience-not-truth: never serve a proof that doesn't reproduce the on-chain root.
  if (bundle.root.toLowerCase() !== meta.root.toLowerCase()) {
    return {
      status: 409,
      body: {
        error: 'Indexed score set does not reproduce the on-chain root',
        recomputedRoot: bundle.root,
        onchainRoot: meta.root,
      },
    }
  }

  return {
    status: 200,
    body: {
      nodeId: bundle.nodeId,
      score: bundle.score,
      proof: bundle.proof,
      root: meta.root,
      // Journal fields the consumer may want alongside the proof.
      ipfsHash: meta.ipfsHash,
      ipfsHashCid: meta.ipfsHashCid,
      totalValue: meta.totalValue,
      skippedDigest: meta.skippedDigest,
      anchorAcc: meta.anchorAcc,
      anchorCount: meta.anchorCount,
      snapshot: meta.merkleSnapshotContract,
    },
  }
}

// GET /hypercerts/roots — discovery: the known roots (newest first), optionally for one snapshot.
hypercertsApp.get('/roots', async (c) => {
  const snapshot = c.req.query('snapshot')
  const rows = await offchainDb.query.hypercertsMetadata.findMany({
    where: snapshot
      ? (t, { eq }) =>
          eq(lower(t.merkleSnapshotContract), snapshot.toLowerCase())
      : undefined,
    orderBy: (t, { desc }) => desc(t.timestamp),
  })
  return c.json({ roots: rows })
})

// GET /hypercerts/score/:nodeId — §10.3 shape: current root of the single instance (?snapshot= / ?root= override).
hypercertsApp.get('/score/:nodeId', async (c) => {
  const nodeId = c.req.param('nodeId')
  const snapshotQ = c.req.query('snapshot')
  const rootQ = c.req.query('root') ?? 'current'

  let snapshot: string
  if (snapshotQ) {
    snapshot = snapshotQ
  } else {
    const meta = await latestMetadata()
    if (!meta) return c.json({ error: 'No hypercerts instance indexed' }, 404)
    snapshot = meta.merkleSnapshotContract
  }

  let root: string
  try {
    root = await resolveRoot(snapshot, rootQ)
  } catch (e: any) {
    return c.json({ error: e.message }, 404)
  }
  const res = await serveBundle(snapshot, root, nodeId)
  return c.json(res.body as object, res.status)
})

// GET /hypercerts/:snapshot/score/:nodeId — bundle at that snapshot's current root.
hypercertsApp.get('/:snapshot/score/:nodeId', async (c) => {
  const { snapshot, nodeId } = c.req.param()
  let root: string
  try {
    root = await resolveRoot(snapshot, 'current')
  } catch (e: any) {
    return c.json({ error: e.message }, 404)
  }
  const res = await serveBundle(snapshot, root, nodeId)
  return c.json(res.body as object, res.status)
})

// GET /hypercerts/:snapshot/:root/score/:nodeId — bundle at an explicit root ("current" allowed).
hypercertsApp.get('/:snapshot/:root/score/:nodeId', async (c) => {
  const { snapshot, root: rootParam, nodeId } = c.req.param()
  let root: string
  try {
    root = await resolveRoot(snapshot, rootParam)
  } catch (e: any) {
    return c.json({ error: e.message }, 404)
  }
  const res = await serveBundle(snapshot, root, nodeId)
  return c.json(res.body as object, res.status)
})

export default hypercertsApp
