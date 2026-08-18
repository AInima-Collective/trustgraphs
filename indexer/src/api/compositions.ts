import { and, asc, count, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from 'ponder:api'
import {
  compositionCapture,
  compositionInstance,
  compositionPolicyVersion,
} from 'ponder:schema'
import { type Hex, isHex } from 'viem'

import { offchainDb } from './db'
import { boundedInteger } from './weighted-prior-api-shared'
import * as offchainSchema from '../../offchain.schema'

declare global {
  interface BigInt {
    toJSON: () => string
  }
}
BigInt.prototype.toJSON = function () {
  return this.toString()
}

const app = new Hono()
const idParam = (value: string) =>
  isHex(value) && value.length === 66 ? (value as Hex) : null
const checkpointParam = (value: string) =>
  /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null
const page = (limit: string | undefined, offset: string | undefined) => ({
  limit: boundedInteger(limit, 50, 500),
  offset: boundedInteger(offset, 0),
})

const serializeInstance = (row: typeof compositionInstance.$inferSelect) => ({
  ...row,
  program: 'trust-compose',
  epochLength: row.epochLength.toString(),
  currentVersion: row.currentVersion.toString(),
  createdBlock: row.createdBlock.toString(),
  createdTimestamp: row.createdTimestamp.toString(),
})

const serializePolicy = (
  row: typeof compositionPolicyVersion.$inferSelect
) => ({
  ...row,
  version: row.version.toString(),
  readyAt: row.readyAt?.toString() ?? null,
  proposedBlock: row.proposedBlock.toString(),
  proposedTimestamp: row.proposedTimestamp.toString(),
  activatedBlock: row.activatedBlock?.toString() ?? null,
  activatedTimestamp: row.activatedTimestamp?.toString() ?? null,
  firstCheckpoint: row.firstCheckpoint?.toString() ?? null,
  firstCheckpointBlock: row.firstCheckpointBlock?.toString() ?? null,
  firstCheckpointTimestamp: row.firstCheckpointTimestamp?.toString() ?? null,
  verifiedAt: row.verifiedAt?.toString() ?? null,
  provenance: {
    cryptographic: {
      paramsHash: row.paramsHash,
      sourcePolicyRoot: row.sourcePolicyRoot,
      sourceCount: row.sourceCount,
      manifestSha256: row.manifestSha256,
    },
    governance: {
      controller: row.controller,
      adapterSetHash: row.adapterSetHash,
      metadataDigest: row.metadataDigest,
      adapters: row.adapters,
      status: row.status,
      sourceTransaction: row.proposedTxHash,
    },
    availability: {
      status: row.availability,
      error: row.availabilityError,
    },
  },
})

app.get('/', async (c) => {
  const pagination = page(c.req.query('limit'), c.req.query('offset'))
  if (pagination.limit === null || pagination.offset === null)
    return c.json(
      { error: 'limit and offset must be non-negative integers' },
      400
    )
  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(compositionInstance)
      .orderBy(desc(compositionInstance.createdBlock))
      .limit(pagination.limit)
      .offset(pagination.offset),
    db
      .select({ value: count(compositionInstance.id) })
      .from(compositionInstance),
  ])
  return c.json({
    instances: rows.map(serializeInstance),
    page: { ...pagination, total: totals[0]?.value ?? 0 },
  })
})

app.get('/:instanceId/policies', async (c) => {
  const instanceId = idParam(c.req.param('instanceId'))
  const pagination = page(c.req.query('limit'), c.req.query('offset'))
  if (!instanceId || pagination.limit === null || pagination.offset === null)
    return c.json({ error: 'invalid instanceId, limit, or offset' }, 400)
  const where = eq(compositionPolicyVersion.instanceId, instanceId)
  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(compositionPolicyVersion)
      .where(where)
      .orderBy(desc(compositionPolicyVersion.version))
      .limit(pagination.limit)
      .offset(pagination.offset),
    db
      .select({ value: count(compositionPolicyVersion.id) })
      .from(compositionPolicyVersion)
      .where(where),
  ])
  return c.json({
    policies: rows.map(serializePolicy),
    page: { ...pagination, total: totals[0]?.value ?? 0 },
  })
})

app.get('/:instanceId/epochs', async (c) => {
  const instanceId = idParam(c.req.param('instanceId'))
  const pagination = page(c.req.query('limit'), c.req.query('offset'))
  if (!instanceId || pagination.limit === null || pagination.offset === null)
    return c.json({ error: 'invalid instanceId, limit, or offset' }, 400)
  const where = eq(offchainSchema.compositionEpoch.instanceId, instanceId)
  const [rows, totals] = await Promise.all([
    offchainDb
      .select()
      .from(offchainSchema.compositionEpoch)
      .where(where)
      .orderBy(desc(offchainSchema.compositionEpoch.checkpointId))
      .limit(pagination.limit)
      .offset(pagination.offset),
    offchainDb
      .select({ value: count(offchainSchema.compositionEpoch.root) })
      .from(offchainSchema.compositionEpoch)
      .where(where),
  ])
  return c.json({
    epochs: rows,
    page: { ...pagination, total: totals[0]?.value ?? 0 },
  })
})

const epochBundle = async (instanceId: Hex, checkpointId: bigint) => {
  const epoch = await offchainDb.query.compositionEpoch.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.instanceId, instanceId),
        eq(table.checkpointId, checkpointId)
      ),
  })
  if (!epoch) return null
  const [instance, capture, policy, sources, attribution, outputEntries] =
    await Promise.all([
      db.query.compositionInstance.findFirst({
        where: eq(compositionInstance.id, instanceId),
      }),
      db.query.compositionCapture.findFirst({
        where: and(
          eq(compositionCapture.instanceId, instanceId),
          eq(compositionCapture.checkpointId, checkpointId)
        ),
      }),
      db.query.compositionPolicyVersion.findFirst({
        where: and(
          eq(compositionPolicyVersion.instanceId, instanceId),
          eq(compositionPolicyVersion.version, epoch.policyVersion)
        ),
      }),
      offchainDb
        .select()
        .from(offchainSchema.compositionSource)
        .where(
          and(
            eq(
              offchainSchema.compositionSource.merkleSnapshotContract,
              epoch.merkleSnapshotContract
            ),
            eq(
              offchainSchema.compositionSource.checkpointId,
              epoch.checkpointId
            )
          )
        )
        .orderBy(asc(offchainSchema.compositionSource.position)),
      offchainDb
        .select()
        .from(offchainSchema.compositionAttribution)
        .where(
          and(
            eq(
              offchainSchema.compositionAttribution.merkleSnapshotContract,
              epoch.merkleSnapshotContract
            ),
            eq(
              offchainSchema.compositionAttribution.checkpointId,
              epoch.checkpointId
            )
          )
        )
        .orderBy(
          asc(offchainSchema.compositionAttribution.sourceId),
          asc(offchainSchema.compositionAttribution.account)
        ),
      offchainDb
        .select()
        .from(offchainSchema.merkleEntry)
        .where(
          and(
            eq(
              offchainSchema.merkleEntry.merkleSnapshotContract,
              epoch.merkleSnapshotContract
            ),
            eq(offchainSchema.merkleEntry.root, epoch.root)
          )
        )
        .orderBy(asc(offchainSchema.merkleEntry.account)),
    ])
  if (!instance || !capture || !policy) return null
  const expectedSources = Number((epoch.work as any).sourceCount)
  const expectedAttribution = Number((epoch.work as any).aggregateEntries)
  const expectedOutput = Number((epoch.work as any).outputAccounts)
  if (
    !Number.isSafeInteger(expectedSources) ||
    !Number.isSafeInteger(expectedAttribution) ||
    !Number.isSafeInteger(expectedOutput) ||
    sources.length !== expectedSources ||
    (capture.sourceCheckpointIds as string[]).length !== expectedSources ||
    attribution.length !== expectedAttribution ||
    outputEntries.length !== expectedOutput
  )
    throw new Error('composition bundle is incomplete; replay ingestion')
  return {
    instance: serializeInstance(instance),
    policy: serializePolicy(policy),
    capture,
    epoch,
    sources,
    attribution,
    outputEntries,
    provenance: {
      cryptographic: epoch.cryptographicProvenance,
      governance: epoch.governanceProvenance,
    },
  }
}

app.get('/:instanceId/epochs/:checkpointId/bundle', async (c) => {
  const instanceId = idParam(c.req.param('instanceId'))
  const checkpoint = checkpointParam(c.req.param('checkpointId'))
  if (!instanceId || checkpoint === null)
    return c.json({ error: 'invalid instanceId or checkpointId' }, 400)
  const bundle = await epochBundle(instanceId, checkpoint)
  return bundle ? c.json(bundle) : c.json({ error: 'not found' }, 404)
})

app.get('/:instanceId/epochs/:checkpointId/sources', async (c) => {
  const instanceId = idParam(c.req.param('instanceId'))
  const checkpoint = checkpointParam(c.req.param('checkpointId'))
  const pagination = page(c.req.query('limit'), c.req.query('offset'))
  if (
    !instanceId ||
    checkpoint === null ||
    pagination.limit === null ||
    pagination.offset === null
  )
    return c.json({ error: 'invalid request parameters' }, 400)
  const epoch = await offchainDb.query.compositionEpoch.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.instanceId, instanceId), eq(table.checkpointId, checkpoint)),
  })
  if (!epoch) return c.json({ error: 'not found' }, 404)
  const where = and(
    eq(
      offchainSchema.compositionSource.merkleSnapshotContract,
      epoch.merkleSnapshotContract
    ),
    eq(offchainSchema.compositionSource.checkpointId, epoch.checkpointId)
  )
  const [rows, totals] = await Promise.all([
    offchainDb
      .select()
      .from(offchainSchema.compositionSource)
      .where(where)
      .orderBy(asc(offchainSchema.compositionSource.position))
      .limit(pagination.limit)
      .offset(pagination.offset),
    offchainDb
      .select({ value: count(offchainSchema.compositionSource.sourceId) })
      .from(offchainSchema.compositionSource)
      .where(where),
  ])
  return c.json({
    sources: rows,
    page: { ...pagination, total: totals[0]?.value ?? 0 },
    provenance: {
      cryptographic: epoch.cryptographicProvenance,
      governance: epoch.governanceProvenance,
    },
  })
})

app.get('/:instanceId/epochs/:checkpointId/attribution', async (c) => {
  const instanceId = idParam(c.req.param('instanceId'))
  const checkpoint = checkpointParam(c.req.param('checkpointId'))
  const pagination = page(c.req.query('limit'), c.req.query('offset'))
  if (
    !instanceId ||
    checkpoint === null ||
    pagination.limit === null ||
    pagination.offset === null
  )
    return c.json({ error: 'invalid request parameters' }, 400)
  const epoch = await offchainDb.query.compositionEpoch.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.instanceId, instanceId), eq(table.checkpointId, checkpoint)),
  })
  if (!epoch) return c.json({ error: 'not found' }, 404)
  const account = c.req.query('account')?.toLowerCase()
  const sourceId = c.req.query('sourceId')?.toLowerCase()
  const filters = [
    eq(
      offchainSchema.compositionAttribution.merkleSnapshotContract,
      epoch.merkleSnapshotContract
    ),
    eq(offchainSchema.compositionAttribution.checkpointId, epoch.checkpointId),
  ]
  if (account)
    filters.push(eq(offchainSchema.compositionAttribution.account, account))
  if (sourceId)
    filters.push(eq(offchainSchema.compositionAttribution.sourceId, sourceId))
  const where = and(...filters)
  const [rows, totals] = await Promise.all([
    offchainDb
      .select()
      .from(offchainSchema.compositionAttribution)
      .where(where)
      .orderBy(
        asc(offchainSchema.compositionAttribution.sourceId),
        asc(offchainSchema.compositionAttribution.account)
      )
      .limit(pagination.limit)
      .offset(pagination.offset),
    offchainDb
      .select({ value: count(offchainSchema.compositionAttribution.account) })
      .from(offchainSchema.compositionAttribution)
      .where(where),
  ])
  return c.json({
    attribution: rows,
    page: { ...pagination, total: totals[0]?.value ?? 0 },
    metrics: epoch.metrics,
    provenance: {
      cryptographic: epoch.cryptographicProvenance,
      governance: epoch.governanceProvenance,
    },
  })
})

export default app
