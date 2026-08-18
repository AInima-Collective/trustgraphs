import { and, asc, count, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
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

declare global {
  interface BigInt {
    toJSON: () => string
  }
}
BigInt.prototype.toJSON = function () {
  return this.toString()
}

const app = new Hono()
const idParam = (value: string | undefined) =>
  value && isHex(value) && value.length === 66 ? (value as Hex) : null
const addressParam = (value: string | undefined) =>
  value && isHex(value) && value.length === 42 ? (value as Hex) : null
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
  indexedLive: boolean
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
    })
  } catch {
    return false
  }
}

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

export default app
