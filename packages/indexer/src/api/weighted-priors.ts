import { and, asc, count, desc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from 'ponder:api'
import {
  merkleGovModule,
  networkMetadataRevision,
  weightedPriorEntry,
  weightedPriorInstance,
  weightedPriorVersion,
} from 'ponder:schema'
import { type Hex, isHex } from 'viem'

import {
  availabilityStatus,
  availabilityView,
  boundedInteger,
  serializeNormalizedEntries,
  versionStatus,
} from './weighted-prior-api-shared'

const app = new Hono()
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

type GovernanceRow = Pick<
  typeof merkleGovModule.$inferSelect,
  'address' | 'merkleSnapshot' | 'target' | 'recoveryModule' | 'executionGuard'
>

const idParam = (value: string) =>
  isHex(value) && value.length === 66 ? (value as Hex) : null

const serializeInstance = (
  row: typeof weightedPriorInstance.$inferSelect,
  governance?: GovernanceRow
) => ({
  ...row,
  program: 'trust-graph-weighted',
  governance: governance
    ? {
        module: governance.address,
        safe: governance.target,
        recoveryModule: governance.recoveryModule,
        executionGuard: governance.executionGuard,
      }
    : null,
  epochLength: row.epochLength.toString(),
  currentVersion: row.currentVersion.toString(),
  metadataRevision: row.metadataRevision.toString(),
  metadataUpdatedBlock: row.metadataUpdatedBlock.toString(),
  metadataUpdatedTimestamp: row.metadataUpdatedTimestamp.toString(),
  metadataUpdated: {
    block: row.metadataUpdatedBlock.toString(),
    timestamp: row.metadataUpdatedTimestamp.toString(),
    txHash: row.metadataUpdatedTxHash,
  },
  createdBlock: row.createdBlock.toString(),
  createdTimestamp: row.createdTimestamp.toString(),
})

const governanceFor = async (
  rows: Array<typeof weightedPriorInstance.$inferSelect>
) => {
  if (rows.length === 0) return new Map<string, GovernanceRow>()
  const governanceRows = await db
    .select({
      address: merkleGovModule.address,
      merkleSnapshot: merkleGovModule.merkleSnapshot,
      target: merkleGovModule.target,
      recoveryModule: merkleGovModule.recoveryModule,
      executionGuard: merkleGovModule.executionGuard,
    })
    .from(merkleGovModule)
    .where(
      inArray(
        merkleGovModule.merkleSnapshot,
        rows.map((row) => row.snapshot)
      )
    )
  return new Map(
    governanceRows.map((governance) => [
      governance.merkleSnapshot.toLowerCase(),
      governance,
    ])
  )
}

const serializeVersion = (row: typeof weightedPriorVersion.$inferSelect) => ({
  id: row.id,
  instanceId: row.instanceId,
  controller: row.controller,
  version: row.version.toString(),
  status: row.status,
  commitments: {
    paramsHash: row.paramsHash,
    previousParamsHash: row.previousParamsHash,
    priorRoot: row.priorRoot,
    priorCount: row.priorCount,
    manifestSha256: row.manifestSha256,
    manifestCid: row.manifestCid,
    metadataDigest: row.metadataDigest,
  },
  params: row.params,
  proposalId: row.proposalId,
  readyAt: row.readyAt?.toString() ?? null,
  proposed: {
    block: row.proposedBlock.toString(),
    timestamp: row.proposedTimestamp.toString(),
    txHash: row.proposedTxHash,
  },
  activated:
    row.activatedBlock === null
      ? null
      : {
          block: row.activatedBlock.toString(),
          timestamp: row.activatedTimestamp!.toString(),
          txHash: row.activatedTxHash,
        },
  firstCheckpoint:
    row.firstCheckpoint === null
      ? null
      : {
          id: row.firstCheckpoint.toString(),
          block: row.firstCheckpointBlock!.toString(),
          timestamp: row.firstCheckpointTimestamp!.toString(),
          txHash: row.firstCheckpointTxHash,
        },
  availability: availabilityView(row),
})

app.get('/', async (c) => {
  const limit = boundedInteger(c.req.query('limit'), 50, 200)
  const offset = boundedInteger(c.req.query('offset'), 0)
  if (limit === null || offset === null) {
    return c.json(
      { error: 'limit and offset must be non-negative integers' },
      400
    )
  }
  const rows = await db
    .select()
    .from(weightedPriorInstance)
    .orderBy(
      desc(weightedPriorInstance.createdBlock),
      desc(weightedPriorInstance.id)
    )
    .limit(limit)
    .offset(offset)
  const [totalRows, governance] = await Promise.all([
    db
      .select({ value: count(weightedPriorInstance.id) })
      .from(weightedPriorInstance),
    governanceFor(rows),
  ])
  return c.json({
    instances: rows.map((row) =>
      serializeInstance(row, governance.get(row.snapshot.toLowerCase()))
    ),
    page: { limit, offset, total: totalRows[0]?.value ?? 0 },
  })
})

app.get('/:instanceId', async (c) => {
  const instanceId = idParam(c.req.param('instanceId'))
  if (!instanceId) return c.json({ error: 'instanceId must be bytes32' }, 400)
  const row = await db.query.weightedPriorInstance.findFirst({
    where: eq(weightedPriorInstance.id, instanceId),
  })
  if (!row) return c.json({ error: 'not found' }, 404)
  const governance = await governanceFor([row])
  return c.json({
    instance: serializeInstance(
      row,
      governance.get(row.snapshot.toLowerCase())
    ),
  })
})

app.get('/:instanceId/metadata-revisions', async (c) => {
  const instanceId = idParam(c.req.param('instanceId'))
  if (!instanceId) return c.json({ error: 'instanceId must be bytes32' }, 400)
  const limit = boundedInteger(c.req.query('limit'), 50, 200)
  const offset = boundedInteger(c.req.query('offset'), 0)
  if (limit === null || offset === null) {
    return c.json(
      { error: 'limit and offset must be non-negative integers' },
      400
    )
  }
  const [rows, total] = await Promise.all([
    db
      .select()
      .from(networkMetadataRevision)
      .where(eq(networkMetadataRevision.instanceId, instanceId))
      .orderBy(desc(networkMetadataRevision.revision))
      .limit(limit)
      .offset(offset),
    db
      .select({ value: count(networkMetadataRevision.id) })
      .from(networkMetadataRevision)
      .where(eq(networkMetadataRevision.instanceId, instanceId)),
  ])
  return c.json({
    revisions: rows.map((row) => ({
      ...row,
      revision: row.revision.toString(),
      blockNumber: row.blockNumber.toString(),
      timestamp: row.timestamp.toString(),
    })),
    page: { limit, offset, total: total[0]?.value ?? 0 },
  })
})

app.get('/:instanceId/versions', async (c) => {
  const instanceId = idParam(c.req.param('instanceId'))
  if (!instanceId) return c.json({ error: 'instanceId must be bytes32' }, 400)
  const limit = boundedInteger(c.req.query('limit'), 50, 200)
  const offset = boundedInteger(c.req.query('offset'), 0)
  if (limit === null || offset === null) {
    return c.json(
      { error: 'limit and offset must be non-negative integers' },
      400
    )
  }
  const status = c.req.query('status')
  if (!versionStatus(status)) {
    return c.json({ error: 'invalid version status' }, 400)
  }
  const availability = c.req.query('availability')
  if (!availabilityStatus(availability)) {
    return c.json({ error: 'invalid availability status' }, 400)
  }
  const filters = [eq(weightedPriorVersion.instanceId, instanceId)]
  if (status) filters.push(eq(weightedPriorVersion.status, status))
  if (availability)
    filters.push(eq(weightedPriorVersion.availability, availability))
  const where = and(...filters)
  const rows = await db
    .select()
    .from(weightedPriorVersion)
    .where(where)
    .orderBy(desc(weightedPriorVersion.version))
    .limit(limit)
    .offset(offset)
  const [total] = await db
    .select({ value: count(weightedPriorVersion.id) })
    .from(weightedPriorVersion)
    .where(where)
  return c.json({
    versions: rows.map(serializeVersion),
    page: { limit, offset, total: total?.value ?? 0 },
  })
})

app.get('/:instanceId/versions/:version', async (c) => {
  const instanceId = idParam(c.req.param('instanceId'))
  const version = boundedInteger(c.req.param('version'), -1)
  if (!instanceId || version === null || version < 1) {
    return c.json(
      { error: 'instanceId must be bytes32 and version must be positive' },
      400
    )
  }
  const row = await db.query.weightedPriorVersion.findFirst({
    where: and(
      eq(weightedPriorVersion.instanceId, instanceId),
      eq(weightedPriorVersion.version, BigInt(version))
    ),
  })
  return row
    ? c.json(serializeVersion(row))
    : c.json({ error: 'not found' }, 404)
})

app.get('/:instanceId/versions/:version/entries', async (c) => {
  const instanceId = idParam(c.req.param('instanceId'))
  const version = boundedInteger(c.req.param('version'), -1)
  const limit = boundedInteger(c.req.query('limit'), DEFAULT_LIMIT, MAX_LIMIT)
  const offset = boundedInteger(c.req.query('offset'), 0)
  if (
    !instanceId ||
    version === null ||
    version < 1 ||
    limit === null ||
    offset === null
  ) {
    return c.json(
      { error: 'invalid instanceId, version, limit, or offset' },
      400
    )
  }
  const versionNumber = BigInt(version)
  const where = and(
    eq(weightedPriorEntry.instanceId, instanceId),
    eq(weightedPriorEntry.version, versionNumber)
  )
  const [metadata, rows, total] = await Promise.all([
    db.query.weightedPriorVersion.findFirst({
      where: and(
        eq(weightedPriorVersion.instanceId, instanceId),
        eq(weightedPriorVersion.version, versionNumber)
      ),
    }),
    db
      .select()
      .from(weightedPriorEntry)
      .where(where)
      .orderBy(asc(weightedPriorEntry.position))
      .limit(limit)
      .offset(offset),
    db
      .select({ value: count(weightedPriorEntry.id) })
      .from(weightedPriorEntry)
      .where(where),
  ])
  if (!metadata) return c.json({ error: 'not found' }, 404)
  return c.json({
    version: serializeVersion(metadata),
    entries: serializeNormalizedEntries(rows),
    page: { limit, offset, total: total[0]?.value ?? 0 },
  })
})

export default app
