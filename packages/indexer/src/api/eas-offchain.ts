import { and, asc, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from 'ponder:api'
import {
  easOffchainAnchor,
  easOffchainLane,
  easOffchainMutation,
  easOffchainNode,
} from 'ponder:schema'
import { type Hex, isAddress, isHex } from 'viem'

const app = new Hono()

const json = (value: unknown): unknown => {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(json)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, json(nested)])
    )
  return value
}

const registryParam = (value: string): Hex | null =>
  isAddress(value) ? (value as Hex) : null

const nodeParam = (value: string): Hex | null =>
  isHex(value) && value.length === 66 ? (value as Hex) : null

app.get('/', async (c) => {
  const lanes = await db
    .select()
    .from(easOffchainLane)
    .orderBy(desc(easOffchainLane.createdBlock))
  return c.json({ lanes: json(lanes) })
})

app.get('/:registry/config', async (c) => {
  const registry = registryParam(c.req.param('registry'))
  if (!registry) return c.json({ error: 'registry must be an address' }, 400)
  const [lane] = await db
    .select()
    .from(easOffchainLane)
    .where(eq(easOffchainLane.registry, registry))
    .limit(1)
  if (!lane) return c.json({ error: 'strict lane not found' }, 404)
  return c.json({ lane: json(lane) })
})

app.get('/:registry/utilization', async (c) => {
  const registry = registryParam(c.req.param('registry'))
  if (!registry) return c.json({ error: 'registry must be an address' }, 400)
  const [lane] = await db
    .select()
    .from(easOffchainLane)
    .where(eq(easOffchainLane.registry, registry))
    .limit(1)
  if (!lane) return c.json({ error: 'strict lane not found' }, 404)
  return c.json({
    registry,
    anchorCount: lane.anchorCount.toString(),
    aggregateEntryCount: lane.aggregateEntryCount.toString(),
    workCount: lane.workCount.toString(),
    maxTotalInputs: lane.maxTotalInputs.toString(),
    utilizationBps:
      lane.maxTotalInputs === 0n
        ? null
        : ((lane.workCount * 10_000n) / lane.maxTotalInputs).toString(),
    validationFailures: lane.validationFailures.toString(),
  })
})

app.get('/:registry/nodes', async (c) => {
  const registry = registryParam(c.req.param('registry'))
  if (!registry) return c.json({ error: 'registry must be an address' }, 400)
  const nodes = await db
    .select()
    .from(easOffchainNode)
    .where(eq(easOffchainNode.registry, registry))
    .orderBy(desc(easOffchainNode.updatedBlock))
  return c.json({ registry, nodes: json(nodes) })
})

app.get('/:registry/nodes/:nodeId', async (c) => {
  const registry = registryParam(c.req.param('registry'))
  const nodeId = nodeParam(c.req.param('nodeId'))
  if (!registry || !nodeId)
    return c.json({ error: 'invalid registry or nodeId' }, 400)
  const [node] = await db
    .select()
    .from(easOffchainNode)
    .where(
      and(
        eq(easOffchainNode.registry, registry),
        eq(easOffchainNode.nodeId, nodeId)
      )
    )
    .limit(1)
  if (!node) return c.json({ error: 'node not found' }, 404)
  return c.json({ node: json(node) })
})

app.get('/:registry/nodes/:nodeId/history', async (c) => {
  const registry = registryParam(c.req.param('registry'))
  const nodeId = nodeParam(c.req.param('nodeId'))
  if (!registry || !nodeId)
    return c.json({ error: 'invalid registry or nodeId' }, 400)
  const history = await db
    .select()
    .from(easOffchainAnchor)
    .where(
      and(
        eq(easOffchainAnchor.registry, registry),
        eq(easOffchainAnchor.nodeId, nodeId)
      )
    )
    .orderBy(desc(easOffchainAnchor.foldIndex))
  return c.json({ history: json(history) })
})

app.get('/:registry/nodes/:nodeId/mutations', async (c) => {
  const registry = registryParam(c.req.param('registry'))
  const nodeId = nodeParam(c.req.param('nodeId'))
  if (!registry || !nodeId)
    return c.json({ error: 'invalid registry or nodeId' }, 400)
  const [node] = await db
    .select()
    .from(easOffchainNode)
    .where(
      and(
        eq(easOffchainNode.registry, registry),
        eq(easOffchainNode.nodeId, nodeId),
        eq(easOffchainNode.verified, true)
      )
    )
    .limit(1)
  if (!node)
    return c.json({ error: 'verified current node head not found' }, 404)
  const mutations = await db
    .select()
    .from(easOffchainMutation)
    .where(eq(easOffchainMutation.anchorId, node.anchorId))
    .orderBy(asc(easOffchainMutation.sequence))
  const active = new Map<string, (typeof mutations)[number]>()
  for (const mutation of mutations) {
    const uid = mutation.uid.toLowerCase()
    if (mutation.kind === 0) active.set(uid, mutation)
    else if (mutation.kind === 1) active.delete(uid)
  }
  return c.json({
    registry,
    nodeId,
    owner: node.owner,
    anchorId: node.anchorId,
    head: node.head,
    count: node.count.toString(),
    // Preserve the endpoint's documented "verified current mutations" meaning while exposing the
    // authenticated ordered log additively for provenance/reconciliation auditors.
    mutations: json([...active.values()]),
    logEntries: json(mutations),
  })
})

app.get('/:registry/cids/:commitment', async (c) => {
  const registry = registryParam(c.req.param('registry'))
  const commitment = nodeParam(c.req.param('commitment'))
  if (!registry || !commitment)
    return c.json({ error: 'invalid registry or commitment' }, 400)
  const anchors = await db
    .select()
    .from(easOffchainAnchor)
    .where(
      and(
        eq(easOffchainAnchor.registry, registry),
        eq(easOffchainAnchor.dataCommitment, commitment)
      )
    )
    .orderBy(desc(easOffchainAnchor.blockNumber))
  if (anchors.length === 0) return c.json({ error: 'CID not found' }, 404)
  return c.json({
    commitment,
    cid: anchors[0]!.cid,
    healthy: anchors.some((anchor) => anchor.verified),
    observations: json(
      anchors.map((anchor) => ({
        anchorId: anchor.id,
        verified: anchor.verified,
        validationError: anchor.validationError,
        gatewayIndex: anchor.gatewayIndex,
        fetchLatencyMs: anchor.fetchLatencyMs,
        blockNumber: anchor.blockNumber,
      }))
    ),
  })
})

export default app
