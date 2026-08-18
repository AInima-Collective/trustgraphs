import { and, asc, count, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { db } from 'ponder:api'
import {
  graphEndorsement,
  graphLineage,
  graphLineageConfiguration,
  graphLineageEpoch,
  scoreProgramBinding,
} from 'ponder:schema'
import { type Hex, createPublicClient, http, isHex } from 'viem'

import { boundedInteger } from './weighted-prior-api-shared'
import { graphLineageRegistryAbi } from '../../abis/graphLineage'
import {
  ENDORSEMENT_KINDS,
  ENDORSEMENT_STATUSES,
  type EndorsementRecord,
  type EndorsementStatus,
  buildReferralAdjacency,
  classifyEndorsement,
  registryTupleLive,
} from '../graph-lineage-shared'
import {
  GRAPH_REPUTATION_ERROR_BOUND,
  GRAPH_REPUTATION_MAX_EDGES,
  GRAPH_REPUTATION_MAX_NODES,
  GRAPH_REPUTATION_PROBATION_SECONDS,
  GRAPH_REPUTATION_SCALE,
  type GraphReputationInput,
  type GraphReputationRoot,
  computeGraphReputation,
  graphReputationL1,
  normalizeGraphWeights,
} from '../graph-reputation'

declare global {
  interface BigInt {
    toJSON: () => string
  }
}
BigInt.prototype.toJSON = function () {
  return this.toString()
}

const app = new Hono()
const RECOMMENDATION_API_MAX_ROOTS = 8
const RECOMMENDATION_API_MAX_ACTIVE_EDGES = 256
const idParam = (value: string | undefined) =>
  value && isHex(value) && value.length === 66
    ? (value.toLowerCase() as Hex)
    : null
const addressParam = (value: string | undefined) =>
  value && isHex(value) && value.length === 42
    ? (value.toLowerCase() as Hex)
    : null
const pagination = (limit: string | undefined, offset: string | undefined) => ({
  limit: boundedInteger(limit, 50, 500) ?? 50,
  offset: boundedInteger(offset, 0) ?? 0,
})

const serializeLineage = (row: typeof graphLineage.$inferSelect) => ({
  ...row,
  currentVersion: row.currentVersion.toString(),
  createdBlock: row.createdBlock.toString(),
  createdTimestamp: row.createdTimestamp.toString(),
  updatedBlock: row.updatedBlock.toString(),
  updatedTimestamp: row.updatedTimestamp.toString(),
})
const serializeConfiguration = (
  row: typeof graphLineageConfiguration.$inferSelect
) => ({
  ...row,
  version: row.version.toString(),
  activatedAt: row.activatedAt.toString(),
  activatedBlock: row.activatedBlock.toString(),
  supersededAtBlock: row.supersededAtBlock?.toString() ?? null,
})
const serializeEpoch = (row: typeof graphLineageEpoch.$inferSelect) => ({
  ...row,
  configurationVersion: row.configurationVersion.toString(),
  checkpointId: row.checkpointId.toString(),
  freezeBlock: row.freezeBlock.toString(),
  acceptedAtBlock: row.acceptedAtBlock.toString(),
  totalValue: row.totalValue.toString(),
  publishedBlock: row.publishedBlock.toString(),
  publishedTimestamp: row.publishedTimestamp.toString(),
})
const serializeEndorsement = (row: typeof graphEndorsement.$inferSelect) => ({
  ...row,
  kind: ENDORSEMENT_KINDS[row.kind] ?? 'unknown',
  kindCode: row.kind,
  weight: row.weight.toString(),
  validFrom: row.validFrom.toString(),
  validUntil: row.validUntil.toString(),
  sequence: row.sequence.toString(),
  revokedAt: row.revokedAt?.toString() ?? null,
  issuedBlock: row.issuedBlock.toString(),
  issuedTimestamp: row.issuedTimestamp.toString(),
  revokedBlock: row.revokedBlock?.toString() ?? null,
})

type IndexState = Awaited<ReturnType<typeof loadIndexState>>
const loadIndexState = async () => {
  const [lineages, configurations, bindings] = await Promise.all([
    db.select().from(graphLineage),
    db.select().from(graphLineageConfiguration),
    db.select().from(scoreProgramBinding),
  ])
  const lineageById = new Map(lineages.map((row) => [row.id, row]))
  const configurationById = new Map(configurations.map((row) => [row.id, row]))
  const newestBinding = new Map<string, (typeof bindings)[number]>()
  for (const binding of bindings) {
    const key = `${binding.sourceRegistry.toLowerCase()}:${binding.instanceId}`
    const previous = newestBinding.get(key)
    if (
      !previous ||
      binding.sourceBlock > previous.sourceBlock ||
      (binding.sourceBlock === previous.sourceBlock &&
        binding.sourceLogIndex > previous.sourceLogIndex)
    )
      newestBinding.set(key, binding)
  }
  const liveByConfiguration = new Map<Hex, boolean>()
  for (const configuration of configurations) {
    const lineage = lineageById.get(configuration.lineageId)
    const binding = lineage
      ? newestBinding.get(
          `${lineage.instanceRegistry.toLowerCase()}:${lineage.instanceId}`
        )
      : undefined
    liveByConfiguration.set(
      configuration.id,
      lineage ? registryTupleLive(lineage, configuration, binding) : false
    )
  }
  return {
    lineageById,
    configurationById,
    liveByConfiguration,
  }
}

const rpcUrlFor = (chainId: string) =>
  chainId === '10'
    ? process.env.PONDER_RPC_URL_10
    : (process.env.PONDER_RPC_URL_31337 ??
      process.env.PONDER_RPC_URL ??
      process.env.RPC_URL ??
      'http://127.0.0.1:8545')
const clients = new Map<string, ReturnType<typeof createPublicClient>>()
const clientFor = (chainId: string) => {
  const url = rpcUrlFor(chainId)
  if (!url) return null
  let client = clients.get(chainId)
  if (!client) {
    client = createPublicClient({ transport: http(url) })
    clients.set(chainId, client)
  }
  return client
}

const indexedStatus = (
  row: typeof graphEndorsement.$inferSelect,
  state: IndexState,
  now: bigint
) => {
  const issuer = state.lineageById.get(row.issuerLineageId)
  const subject = state.lineageById.get(row.subjectLineageId)
  return classifyEndorsement(
    row as EndorsementRecord,
    now,
    {
      currentConfigurationId: issuer?.currentConfigurationId ?? null,
      live:
        issuer?.currentConfigurationId !== null &&
        issuer?.currentConfigurationId !== undefined
          ? (state.liveByConfiguration.get(issuer.currentConfigurationId) ??
            false)
          : false,
    },
    {
      currentConfigurationId: subject?.currentConfigurationId ?? null,
      live:
        subject?.currentConfigurationId !== null &&
        subject?.currentConfigurationId !== undefined
          ? (state.liveByConfiguration.get(subject.currentConfigurationId) ??
            false)
          : false,
    },
    row.scopeHash,
    row.subjectConfigurationId
  )
}

const overlapFor = (
  row: typeof graphEndorsement.$inferSelect,
  state: IndexState
) => {
  const issuer = state.configurationById.get(row.issuerConfigurationId)
  const subject = state.configurationById.get(row.subjectConfigurationId)
  if (!issuer || !subject) return null
  return {
    family: issuer.familyId === subject.familyId,
    method: issuer.methodId === subject.methodId,
    controller: sameAddress(issuer.controller, subject.controller),
    authority: sameAddress(issuer.authority, subject.authority),
  }
}

const sameAddress = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase()
const compareKey = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0
const decimalBigInt = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error(`${label} must be canonical unsigned integer strings`)
  return BigInt(value)
}

/** Controller ownership can rotate without an InstanceRegistry write, so confirm indexed-active
 * records against the canonical contract view. RPC failure is fail-closed, never `active`. */
const canonicalStatus = async (
  row: typeof graphEndorsement.$inferSelect,
  state: IndexState,
  now: bigint
): Promise<EndorsementStatus | 'verification-unavailable'> => {
  const indexed = indexedStatus(row, state, now)
  if (indexed !== 'active') return indexed
  const issuer = state.lineageById.get(row.issuerLineageId)
  const client = issuer ? clientFor(issuer.chainId) : null
  if (!client) return 'verification-unavailable'
  try {
    const code = await client.readContract({
      address: row.registry,
      abi: graphLineageRegistryAbi,
      functionName: 'endorsementStatus',
      args: [row.id, row.scopeHash, row.subjectConfigurationId],
    })
    return ENDORSEMENT_STATUSES[Number(code)] ?? 'verification-unavailable'
  } catch {
    return 'verification-unavailable'
  }
}

const canonicalConfigurationLive = async (
  lineage: typeof graphLineage.$inferSelect,
  configurationId: Hex,
  indexedLive: boolean,
  blockNumber?: bigint
) => {
  if (!indexedLive) return false
  const client = clientFor(lineage.chainId)
  if (!client) return false
  try {
    return await client.readContract({
      address: lineage.registry,
      abi: graphLineageRegistryAbi,
      functionName: 'configurationLive',
      args: [configurationId],
      blockNumber,
    })
  } catch {
    return false
  }
}

type RecommendationRequest = {
  scopeHash: Hex
  roots: GraphReputationRoot[]
  manualWeights: Map<Hex, bigint>
}

const recommendationRequest = async (
  request: Request
): Promise<RecommendationRequest> => {
  const body: any = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') throw new Error('invalid JSON body')
  const scopeHash = idParam(body.scopeHash)
  if (!scopeHash) throw new Error('a valid scopeHash is required')
  if (
    !Array.isArray(body.roots) ||
    body.roots.length === 0 ||
    body.roots.length > RECOMMENDATION_API_MAX_ROOTS
  )
    throw new Error(
      `roots must contain 1-${RECOMMENDATION_API_MAX_ROOTS} entries`
    )
  const seen = new Set<Hex>()
  let total = 0n
  const roots: GraphReputationRoot[] = body.roots.map((entry: any) => {
    const lineageId = idParam(entry?.lineageId)
    if (!lineageId || seen.has(lineageId))
      throw new Error('roots must contain unique valid lineage ids')
    seen.add(lineageId)
    const weight = decimalBigInt(entry.weight, 'root weights')
    if (weight <= 0n || weight > GRAPH_REPUTATION_SCALE)
      throw new Error('root weights must be positive fixed-point values')
    total += weight
    return { lineageId, weight }
  })
  if (total !== GRAPH_REPUTATION_SCALE)
    throw new Error(`root weights must sum to ${GRAPH_REPUTATION_SCALE}`)
  const manualWeights = new Map<Hex, bigint>()
  if (body.manualWeights !== undefined) {
    if (!Array.isArray(body.manualWeights))
      throw new Error('manualWeights must be an array')
    for (const entry of body.manualWeights) {
      const lineageId = idParam(entry?.lineageId)
      if (!lineageId || manualWeights.has(lineageId))
        throw new Error('manualWeights must contain unique valid lineage ids')
      const weight = decimalBigInt(entry.weight, 'manual weights')
      if (weight < 0n || weight > GRAPH_REPUTATION_SCALE)
        throw new Error('manual weights must be fixed-point values')
      manualWeights.set(lineageId, weight)
    }
    if (
      [...manualWeights.values()].reduce((sum, weight) => sum + weight, 0n) !==
      GRAPH_REPUTATION_SCALE
    )
      throw new Error(`manual weights must sum to ${GRAPH_REPUTATION_SCALE}`)
  }
  return { scopeHash, roots, manualWeights }
}

const bigintJson = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item
    )
  )

app.use(
  '/recommendations',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) =>
      c.json({ error: 'recommendation request is too large' }, 413),
  })
)

app.get('/lineages', async (c) => {
  const { limit, offset } = pagination(
    c.req.query('limit'),
    c.req.query('offset')
  )
  const familyId = idParam(c.req.query('familyId'))
  const authority = addressParam(c.req.query('authority'))
  if (c.req.query('familyId') && !familyId)
    return c.json({ error: 'invalid familyId' }, 400)
  if (c.req.query('authority') && !authority)
    return c.json({ error: 'invalid authority' }, 400)
  const conditions: any[] = []
  if (familyId) conditions.push(eq(graphLineage.familyId, familyId))
  if (authority) conditions.push(eq(graphLineage.authority, authority))
  const where = conditions.length ? and(...conditions) : undefined
  const [rows, total] = await Promise.all([
    db
      .select()
      .from(graphLineage)
      .where(where)
      .orderBy(asc(graphLineage.id))
      .limit(limit)
      .offset(offset),
    db.select({ count: count() }).from(graphLineage).where(where),
  ])
  const state = await loadIndexState()
  const items = await Promise.all(
    rows.map(async (row) => {
      const configuration = row.currentConfigurationId
        ? state.configurationById.get(row.currentConfigurationId)
        : undefined
      const indexedLive = configuration
        ? (state.liveByConfiguration.get(configuration.id) ?? false)
        : false
      return {
        ...serializeLineage(row),
        currentConfiguration: configuration
          ? serializeConfiguration(configuration)
          : null,
        authenticatedLive:
          configuration !== undefined
            ? await canonicalConfigurationLive(
                row,
                configuration.id,
                indexedLive
              )
            : false,
      }
    })
  )
  return c.json({
    items,
    pagination: {
      limit,
      offset,
      total: Number(total[0]?.count ?? 0),
      hasMore: offset + items.length < Number(total[0]?.count ?? 0),
    },
  })
})

app.get('/lineages/:lineageId', async (c) => {
  const lineageId = idParam(c.req.param('lineageId'))
  if (!lineageId) return c.json({ error: 'invalid lineage id' }, 400)
  const lineage = await db.query.graphLineage.findFirst({
    where: eq(graphLineage.id, lineageId),
  })
  if (!lineage) return c.json({ error: 'lineage not found' }, 404)
  const [configurations, epochs, state] = await Promise.all([
    db
      .select()
      .from(graphLineageConfiguration)
      .where(eq(graphLineageConfiguration.lineageId, lineageId))
      .orderBy(desc(graphLineageConfiguration.version)),
    db
      .select()
      .from(graphLineageEpoch)
      .where(eq(graphLineageEpoch.lineageId, lineageId))
      .orderBy(desc(graphLineageEpoch.freezeBlock))
      .limit(100),
    loadIndexState(),
  ])
  const configurationHistory = await Promise.all(
    configurations.map(async (configuration) => ({
      ...serializeConfiguration(configuration),
      authenticatedLive: await canonicalConfigurationLive(
        lineage,
        configuration.id,
        state.liveByConfiguration.get(configuration.id) ?? false
      ),
    }))
  )
  return c.json({
    lineage: serializeLineage(lineage),
    configurations: configurationHistory,
    epochs: epochs.map(serializeEpoch),
    authorityPolicy:
      'Only the live InstanceRegistry params controller (or its owner()) authenticates changes.',
  })
})

app.get('/epochs', async (c) => {
  const { limit, offset } = pagination(
    c.req.query('limit'),
    c.req.query('offset')
  )
  const lineageId = idParam(c.req.query('lineageId'))
  if (c.req.query('lineageId') && !lineageId)
    return c.json({ error: 'invalid lineageId' }, 400)
  const rows = await db
    .select()
    .from(graphLineageEpoch)
    .where(lineageId ? eq(graphLineageEpoch.lineageId, lineageId) : undefined)
    .orderBy(desc(graphLineageEpoch.freezeBlock), asc(graphLineageEpoch.id))
    .limit(limit + 1)
    .offset(offset)
  return c.json({
    items: rows.slice(0, limit).map(serializeEpoch),
    pagination: { limit, offset, hasMore: rows.length > limit },
  })
})

app.get('/endorsements', async (c) => {
  const { limit, offset } = pagination(
    c.req.query('limit'),
    c.req.query('offset')
  )
  const issuer = idParam(c.req.query('issuer'))
  const subject = idParam(c.req.query('subject'))
  const scopeHash = idParam(c.req.query('scopeHash'))
  const kindName = c.req.query('kind')
  const kind = kindName ? ENDORSEMENT_KINDS.indexOf(kindName as any) : -1
  const statusFilter = c.req.query('status')
  if (c.req.query('issuer') && !issuer)
    return c.json({ error: 'invalid issuer' }, 400)
  if (c.req.query('subject') && !subject)
    return c.json({ error: 'invalid subject' }, 400)
  if (c.req.query('scopeHash') && !scopeHash)
    return c.json({ error: 'invalid scopeHash' }, 400)
  if (kindName && kind < 0) return c.json({ error: 'invalid kind' }, 400)
  if (
    statusFilter &&
    !ENDORSEMENT_STATUSES.includes(statusFilter as any) &&
    statusFilter !== 'verification-unavailable'
  )
    return c.json({ error: 'invalid status' }, 400)
  const conditions: any[] = []
  if (issuer) conditions.push(eq(graphEndorsement.issuerLineageId, issuer))
  if (subject) conditions.push(eq(graphEndorsement.subjectLineageId, subject))
  if (scopeHash) conditions.push(eq(graphEndorsement.scopeHash, scopeHash))
  if (kind >= 0) conditions.push(eq(graphEndorsement.kind, kind))
  const rows = await db
    .select()
    .from(graphEndorsement)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(
      desc(graphEndorsement.issuedBlock),
      desc(graphEndorsement.sequence)
    )
    .limit(statusFilter ? 5_000 : limit + 1)
    .offset(statusFilter ? 0 : offset)
  const state = await loadIndexState()
  const now = BigInt(Math.floor(Date.now() / 1000))
  const withStatus = await Promise.all(
    rows.map(async (row) => ({
      ...serializeEndorsement(row),
      status: await canonicalStatus(row, state, now),
      overlap: overlapFor(row, state),
    }))
  )
  const filtered = statusFilter
    ? withStatus.filter((row) => row.status === statusFilter)
    : withStatus
  const pageRows = statusFilter
    ? filtered.slice(offset, offset + limit)
    : filtered.slice(0, limit)
  return c.json({
    items: pageRows,
    pagination: {
      limit,
      offset,
      hasMore: statusFilter
        ? filtered.length > offset + limit
        : rows.length > limit,
    },
  })
})

app.get('/endorsements/:endorsementId', async (c) => {
  const endorsementId = idParam(c.req.param('endorsementId'))
  if (!endorsementId) return c.json({ error: 'invalid endorsement id' }, 400)
  const row = await db.query.graphEndorsement.findFirst({
    where: eq(graphEndorsement.id, endorsementId),
  })
  if (!row) return c.json({ error: 'endorsement not found' }, 404)
  const state = await loadIndexState()
  return c.json({
    endorsement: serializeEndorsement(row),
    overlap: overlapFor(row, state),
    status: await canonicalStatus(
      row,
      state,
      BigInt(Math.floor(Date.now() / 1000))
    ),
  })
})

app.get('/referrals', async (c) => {
  const scopeHash = idParam(c.req.query('scopeHash'))
  if (!scopeHash) return c.json({ error: 'a valid scopeHash is required' }, 400)
  const rows = await db
    .select()
    .from(graphEndorsement)
    .where(
      and(
        eq(graphEndorsement.scopeHash, scopeHash),
        eq(graphEndorsement.kind, 2)
      )
    )
    .orderBy(asc(graphEndorsement.issuerLineageId), asc(graphEndorsement.id))
    .limit(5_000)
  const state = await loadIndexState()
  const now = BigInt(Math.floor(Date.now() / 1000))
  const statusEntries = await Promise.all(
    rows.map(
      async (row) => [row.id, await canonicalStatus(row, state, now)] as const
    )
  )
  const statuses = new Map(statusEntries)
  const referralConfigurations = new Map(
    [...state.configurationById.values()].map((configuration) => [
      configuration.id,
      configuration,
    ])
  )
  const result = buildReferralAdjacency(
    rows as EndorsementRecord[],
    statuses,
    referralConfigurations
  )
  const nonActive = statusEntries
    .filter(([, status]) => status !== 'active')
    .map(([endorsementId, status]) => ({ endorsementId, status }))
  return c.json({
    scopeHash,
    previousEpochOnly: true,
    advisoryOnly: true,
    ...result,
    excluded: nonActive,
    warning:
      'Referral edges recommend sources only. They do not mutate trust-compose weights, scores, roots, or proofs.',
  })
})

app.post('/recommendations', async (c) => {
  let request: Awaited<ReturnType<typeof recommendationRequest>>
  try {
    request = await recommendationRequest(c.req.raw)
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : 'invalid request' },
      400
    )
  }

  const state = await loadIndexState()
  const rootLineages = request.roots.map((root) =>
    state.lineageById.get(root.lineageId)
  )
  if (rootLineages.some((lineage) => !lineage))
    return c.json({ error: 'trusted-root history is unavailable' }, 422)
  const anchor = rootLineages[0]!
  if (
    rootLineages.some(
      (lineage) =>
        lineage!.chainId !== anchor.chainId ||
        !sameAddress(lineage!.registry, anchor.registry)
    )
  )
    return c.json(
      { error: 'all trusted roots must share one chain and lineage registry' },
      400
    )
  const client = clientFor(anchor.chainId)
  if (!client)
    return c.json({ error: 'finalized RPC verification is unavailable' }, 503)

  let cutoffBlock: bigint
  let cutoffTimestamp: bigint
  try {
    const finalized = await client.getBlock({ blockTag: 'finalized' })
    cutoffBlock = finalized.number
    cutoffTimestamp = finalized.timestamp
  } catch {
    return c.json({ error: 'finalized RPC verification is unavailable' }, 503)
  }

  const candidateLineages = [...state.lineageById.values()]
    .filter(
      (lineage) =>
        lineage.chainId === anchor.chainId &&
        sameAddress(lineage.registry, anchor.registry)
    )
    .sort((left, right) => compareKey(left.id, right.id))
  if (candidateLineages.length > GRAPH_REPUTATION_MAX_NODES)
    return c.json(
      {
        error: `eligible registry exceeds the ${GRAPH_REPUTATION_MAX_NODES}-node deterministic bound`,
      },
      422
    )
  const [epochs, endorsementRows] = await Promise.all([
    db.select().from(graphLineageEpoch),
    db
      .select()
      .from(graphEndorsement)
      .where(
        and(
          eq(graphEndorsement.registry, anchor.registry),
          eq(graphEndorsement.scopeHash, request.scopeHash),
          eq(graphEndorsement.kind, 2)
        )
      )
      .orderBy(asc(graphEndorsement.issuerLineageId), asc(graphEndorsement.id))
      .limit(GRAPH_REPUTATION_MAX_EDGES + 1),
  ])
  if (endorsementRows.length > GRAPH_REPUTATION_MAX_EDGES)
    return c.json(
      {
        error: `referral set exceeds the ${GRAPH_REPUTATION_MAX_EDGES}-edge deterministic bound`,
      },
      422
    )

  const newestEpoch = new Map<Hex, (typeof epochs)[number]>()
  for (const epoch of epochs) {
    if (
      epoch.acceptedAtBlock >= cutoffBlock ||
      epoch.publishedBlock >= cutoffBlock
    )
      continue
    const previous = newestEpoch.get(epoch.lineageId)
    if (
      !previous ||
      epoch.publishedBlock > previous.publishedBlock ||
      (epoch.publishedBlock === previous.publishedBlock &&
        compareKey(epoch.id, previous.id) > 0)
    )
      newestEpoch.set(epoch.lineageId, epoch)
  }

  const excluded: Array<{ lineageId: Hex; reason: string }> = []
  const nodeRows: Array<{
    lineage: (typeof candidateLineages)[number]
    configuration: typeof graphLineageConfiguration.$inferSelect
    epoch: (typeof epochs)[number]
  }> = []
  await Promise.all(
    candidateLineages.map(async (lineage) => {
      const epoch = newestEpoch.get(lineage.id)
      if (!epoch) {
        excluded.push({
          lineageId: lineage.id,
          reason: 'previous-epoch-unavailable',
        })
        return
      }
      const configuration = state.configurationById.get(epoch.configurationId)
      if (
        !configuration ||
        lineage.currentConfigurationId !== configuration.id
      ) {
        excluded.push({
          lineageId: lineage.id,
          reason: 'configuration-rotated',
        })
        return
      }
      const live = await canonicalConfigurationLive(
        lineage,
        configuration.id,
        state.liveByConfiguration.get(configuration.id) ?? false,
        cutoffBlock
      )
      if (!live) {
        excluded.push({
          lineageId: lineage.id,
          reason: 'canonical-liveness-unavailable',
        })
        return
      }
      nodeRows.push({ lineage, configuration, epoch })
    })
  )
  nodeRows.sort((left, right) => compareKey(left.lineage.id, right.lineage.id))
  const includedIds = new Set(nodeRows.map(({ lineage }) => lineage.id))
  if (request.roots.some((root) => !includedIds.has(root.lineageId)))
    return c.json(
      {
        error:
          'a trusted root lacks a live current configuration and a strictly previous finalized epoch',
        excluded,
      },
      422
    )

  const endorsementById = new Map(
    endorsementRows.map((endorsement) => [endorsement.id, endorsement])
  )
  const activeRows = endorsementRows.filter((endorsement) => {
    if (
      !includedIds.has(endorsement.issuerLineageId) ||
      !includedIds.has(endorsement.subjectLineageId) ||
      endorsement.issuedBlock >= cutoffBlock ||
      endorsement.validFrom > cutoffTimestamp ||
      endorsement.validUntil <= cutoffTimestamp ||
      (endorsement.revokedBlock !== null &&
        endorsement.revokedBlock <= cutoffBlock)
    )
      return false
    const successor = endorsement.supersededBy
      ? endorsementById.get(endorsement.supersededBy)
      : undefined
    if (successor && successor.issuedBlock <= cutoffBlock) return false
    const issuer = nodeRows.find(
      ({ lineage }) => lineage.id === endorsement.issuerLineageId
    )!
    const subject = nodeRows.find(
      ({ lineage }) => lineage.id === endorsement.subjectLineageId
    )!
    return (
      issuer.configuration.id === endorsement.issuerConfigurationId &&
      subject.configuration.id === endorsement.subjectConfigurationId
    )
  })
  if (activeRows.length > RECOMMENDATION_API_MAX_ACTIVE_EDGES)
    return c.json(
      {
        error: `active referral set exceeds the ${RECOMMENDATION_API_MAX_ACTIVE_EDGES}-edge interactive bound`,
      },
      422
    )
  if (
    [...request.manualWeights.keys()].some(
      (lineageId) => !includedIds.has(lineageId)
    )
  )
    return c.json(
      { error: 'manual weights reference unavailable lineages' },
      400
    )

  const input: GraphReputationInput = {
    version: 1,
    chainId: BigInt(anchor.chainId),
    registry: anchor.registry,
    scopeHash: request.scopeHash,
    cutoffBlock,
    finalizedBlock: cutoffBlock,
    cutoffTimestamp,
    roots: request.roots,
    nodes: nodeRows.map(({ lineage, configuration, epoch }) => ({
      lineageId: lineage.id,
      configurationId: configuration.id,
      epochId: epoch.id,
      familyId: configuration.familyId,
      methodId: configuration.methodId,
      controller: configuration.controller,
      authority: configuration.authority,
      createdAt: lineage.createdTimestamp,
      epochAcceptedBlock: epoch.acceptedAtBlock,
      epochPublishedBlock: epoch.publishedBlock,
    })),
    edges: activeRows.map((endorsement) => ({
      endorsementId: endorsement.id,
      issuerLineageId: endorsement.issuerLineageId,
      subjectLineageId: endorsement.subjectLineageId,
      issuerConfigurationId: endorsement.issuerConfigurationId,
      subjectConfigurationId: endorsement.subjectConfigurationId,
      scopeHash: endorsement.scopeHash,
      weight: BigInt(endorsement.weight),
      validFrom: endorsement.validFrom,
      validUntil: endorsement.validUntil,
      issuedBlock: endorsement.issuedBlock,
      evidenceDigest: endorsement.evidenceDigest,
      revokedAt: null,
      supersededBy: null,
    })),
  }

  let result: ReturnType<typeof computeGraphReputation>
  try {
    result = computeGraphReputation(input)
  } catch (error) {
    return c.json(
      {
        error: 'the finalized recommendation input failed closed',
        detail: error instanceof Error ? error.message : 'invalid graph',
      },
      422
    )
  }
  if (!result.converged)
    return c.json(
      {
        error:
          'the deterministic fixed point exceeded its declared residual bound',
        residual: result.residual.toString(),
      },
      422
    )
  const rootIds = new Set(request.roots.map((root) => root.lineageId))
  const recommendationEntries = result.scores
    .map((score) => {
      const row = nodeRows.find(
        ({ lineage }) => lineage.id === score.lineageId
      )!
      const probationEndsAt =
        row.lineage.createdTimestamp + GRAPH_REPUTATION_PROBATION_SECONDS
      const probation =
        !rootIds.has(score.lineageId) && probationEndsAt > cutoffTimestamp
      const overlap = {
        family: nodeRows.some(
          ({ lineage, configuration }) =>
            lineage.id !== score.lineageId &&
            configuration.familyId === row.configuration.familyId
        ),
        method: nodeRows.some(
          ({ lineage, configuration }) =>
            lineage.id !== score.lineageId &&
            configuration.methodId === row.configuration.methodId
        ),
        controller: nodeRows.some(
          ({ lineage, configuration }) =>
            lineage.id !== score.lineageId &&
            sameAddress(configuration.controller, row.configuration.controller)
        ),
        publisherAuthority: nodeRows.some(
          ({ lineage, configuration }) =>
            lineage.id !== score.lineageId &&
            sameAddress(configuration.authority, row.configuration.authority)
        ),
      }
      const incoming = activeRows.filter(
        (endorsement) => endorsement.subjectLineageId === score.lineageId
      )
      return {
        ...score,
        displayName: row.lineage.displayName,
        configurationId: row.configuration.id,
        epochId: row.epoch.id,
        eligible: !probation && score.score > 0n,
        eligibilityReason:
          score.score === 0n
            ? 'zero-trusted-ingress'
            : probation
              ? 'probation'
              : rootIds.has(score.lineageId)
                ? 'trusted-root'
                : 'eligible',
        probationEndsAt,
        overlap,
        evidenceMutable: incoming.some(
          (endorsement) => endorsement.evidenceMutable
        ),
        nextReferralExpiry:
          incoming.length > 0
            ? incoming.reduce(
                (minimum, endorsement) =>
                  endorsement.validUntil < minimum
                    ? endorsement.validUntil
                    : minimum,
                incoming[0]!.validUntil
              )
            : null,
      }
    })
    .sort((left, right) => left.rank - right.rank)
  const eligible = recommendationEntries.filter((entry) => entry.eligible)
  const recommended = new Map<Hex, bigint>(
    eligible.length > 0
      ? normalizeGraphWeights(
          eligible.map((entry) => ({
            key: entry.lineageId,
            weight: entry.score,
            data: entry.lineageId,
          }))
        ).map((entry) => [entry.data, entry.weight])
      : []
  )
  const recommendations = recommendationEntries.map((entry) => {
    const recommendedWeight = recommended.get(entry.lineageId) ?? 0n
    const manualWeight = request.manualWeights.get(entry.lineageId) ?? null
    return {
      ...entry,
      recommendedWeight,
      manualWeight,
      manualDelta:
        manualWeight === null ? null : manualWeight - recommendedWeight,
    }
  })
  const sensitivity = request.roots.map((omitted) => {
    if (request.roots.length === 1)
      return { omittedRoot: omitted.lineageId, l1Distance: null }
    const remaining = request.roots.filter(
      (root) => root.lineageId !== omitted.lineageId
    )
    const normalized = normalizeGraphWeights(
      remaining.map((root) => ({
        key: root.lineageId,
        weight: root.weight,
        data: root.lineageId,
      }))
    ).map(({ data, weight }) => ({ lineageId: data, weight }))
    return {
      omittedRoot: omitted.lineageId,
      l1Distance: graphReputationL1(
        result,
        computeGraphReputation({ ...input, roots: normalized })
      ),
    }
  })

  // This endpoint is deliberately read-only: it never writes a composition policy, changes a
  // source weight, signs a transaction, or applies a recommendation.
  return c.json(
    bigintJson({
      advisoryOnly: true,
      previousFinalizedEpochOnly: true,
      algorithm: {
        version: 1,
        scale: GRAPH_REPUTATION_SCALE,
        damping: '850000000000000000',
        iterations: result.iterations,
        residual: result.residual,
        errorBound: GRAPH_REPUTATION_ERROR_BOUND,
        converged: result.converged,
      },
      cutoff: {
        chainId: anchor.chainId,
        registry: anchor.registry,
        scopeHash: request.scopeHash,
        block: cutoffBlock,
        timestamp: cutoffTimestamp,
        finalizedBlock: cutoffBlock,
      },
      inputCommitment: result.inputCommitment,
      resultCommitment: result.resultCommitment,
      roots: request.roots,
      recommendations,
      families: result.families,
      budgets: result.matrix,
      sensitivity,
      excluded,
      nextExpiry:
        activeRows.length > 0
          ? activeRows.reduce(
              (minimum, endorsement) =>
                endorsement.validUntil < minimum
                  ? endorsement.validUntil
                  : minimum,
              activeRows[0]!.validUntil
            )
          : null,
      warnings: [
        'Sparse trusted roots are an external Sybil boundary; no uniform permissionless prior is used.',
        'Family, controller, publisher-authority, method, and mutable-evidence overlap remain visible.',
        'Recommendations are advisory and never mutate trust-compose defaults or create a transaction.',
      ],
    })
  )
})

export default app
