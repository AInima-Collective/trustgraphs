import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  lte,
  max,
  min,
  notExists,
} from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from 'ponder:api'
import {
  easCanonicalAttestation,
  easImportOperation,
  easImportSyncHead,
  easSchemaRecord,
  instance,
} from 'ponder:schema'
import { type Hex, isHex } from 'viem'

const app = new Hono()

const uidParam = (value: string): Hex | null =>
  isHex(value) && value.length === 66 ? (value as Hex) : null

const fields = (schema: string) =>
  schema
    .split(',')
    .map((field, index) => {
      const [type = '', name = ''] = field.trim().split(/\s+/)
      return {
        index,
        type,
        name,
        numeric: /^(u?int)(8|16|32|64|128|256)?$/.test(type),
      }
    })
    .filter(({ type }) => type.length > 0)

app.get('/schemas/:uid/preview', async (c) => {
  const uid = uidParam(c.req.param('uid'))
  if (!uid) return c.json({ error: 'uid must be bytes32' }, 400)
  const registered = await db.query.easSchemaRecord.findFirst({
    where: eq(easSchemaRecord.uid, uid),
  })
  if (!registered) return c.json({ error: 'schema not found' }, 404)

  const [summary] = await db
    .select({
      attestations: count(easCanonicalAttestation.uid),
      uniqueAttesters: countDistinct(easCanonicalAttestation.attester),
      uniqueRecipients: countDistinct(easCanonicalAttestation.recipient),
    })
    .from(easCanonicalAttestation)
    .where(eq(easCanonicalAttestation.schema, uid))
  const samples = await db
    .select({
      uid: easCanonicalAttestation.uid,
      attester: easCanonicalAttestation.attester,
      recipient: easCanonicalAttestation.recipient,
      data: easCanonicalAttestation.data,
      time: easCanonicalAttestation.sourceTime,
      expirationTime: easCanonicalAttestation.expirationTime,
      revocationTime: easCanonicalAttestation.revocationTime,
      blockNumber: easCanonicalAttestation.sourceBlock,
    })
    .from(easCanonicalAttestation)
    .where(eq(easCanonicalAttestation.schema, uid))
    .orderBy(desc(easCanonicalAttestation.sourceBlock))
    .limit(24)
  const schemaFields = fields(registered.schema)
  return c.json({
    schema: {
      uid: registered.uid,
      schema: registered.schema,
      resolver: registered.resolver,
      revocable: registered.revocable,
      registerer: registered.registerer,
      fields: schemaFields,
      numericWeightCandidates: schemaFields.filter((field) => field.numeric),
    },
    counts: {
      attestations: Number(summary?.attestations ?? 0),
      uniqueAttesters: Number(summary?.uniqueAttesters ?? 0),
      uniqueRecipients: Number(summary?.uniqueRecipients ?? 0),
    },
    // Raw payloads are deliberate: the browser uses EAS's SchemaEncoder for the exact registered
    // schema, so malformed legacy rows stay visible rather than making this endpoint fail.
    samples: samples.map((sample) => ({
      ...sample,
      time: sample.time.toString(),
      expirationTime: sample.expirationTime.toString(),
      revocationTime: sample.revocationTime.toString(),
      blockNumber: sample.blockNumber.toString(),
    })),
    graphPreview: {
      nodes: new Set(
        samples.flatMap((sample) => [sample.attester, sample.recipient])
      ).size,
      edges: samples.length,
      sampled: samples.length < Number(summary?.attestations ?? 0),
    },
  })
})

const pendingMinimum = async (
  importer: Hex,
  schemaUid: Hex,
  kind: 0 | 1 | 2,
  now: bigint
) => {
  const eligibility =
    kind === 0
      ? eq(easCanonicalAttestation.schema, schemaUid)
      : kind === 1
        ? and(
            eq(easCanonicalAttestation.schema, schemaUid),
            gt(easCanonicalAttestation.revocationTime, 0n)
          )
        : and(
            eq(easCanonicalAttestation.schema, schemaUid),
            gt(easCanonicalAttestation.expirationTime, 0n),
            lte(easCanonicalAttestation.expirationTime, now)
          )
  const [row] = await db
    .select({ block: min(easCanonicalAttestation.sourceBlock) })
    .from(easCanonicalAttestation)
    .where(
      and(
        eligibility,
        notExists(
          db
            .select({ id: easImportOperation.id })
            .from(easImportOperation)
            .where(
              and(
                eq(easImportOperation.importer, importer),
                eq(easImportOperation.uid, easCanonicalAttestation.uid),
                eq(easImportOperation.kind, kind)
              )
            )
        )
      )
    )
  return row?.block ?? null
}

const canonicalCount = async (schemaUid: Hex, kind: 0 | 1 | 2, now: bigint) => {
  const where =
    kind === 0
      ? eq(easCanonicalAttestation.schema, schemaUid)
      : kind === 1
        ? and(
            eq(easCanonicalAttestation.schema, schemaUid),
            gt(easCanonicalAttestation.revocationTime, 0n)
          )
        : and(
            eq(easCanonicalAttestation.schema, schemaUid),
            gt(easCanonicalAttestation.expirationTime, 0n),
            lte(easCanonicalAttestation.expirationTime, now)
          )
  const [row] = await db
    .select({ value: count(easCanonicalAttestation.uid) })
    .from(easCanonicalAttestation)
    .where(where)
  return Number(row?.value ?? 0)
}

const importedCount = async (importer: Hex, kind: 0 | 1 | 2) => {
  const [row] = await db
    .select({ value: count(easImportOperation.id) })
    .from(easImportOperation)
    .where(
      and(
        eq(easImportOperation.importer, importer),
        eq(easImportOperation.kind, kind)
      )
    )
  return Number(row?.value ?? 0)
}

app.get('/instances/:id/status', async (c) => {
  const instanceId = uidParam(c.req.param('id'))
  if (!instanceId) return c.json({ error: 'id must be bytes32' }, 400)
  const network = await db.query.instance.findFirst({
    where: eq(instance.id, instanceId),
  })
  if (!network?.importedEas || !network.importedRouter) {
    return c.json({ error: 'imported EAS lane not found' }, 404)
  }
  const importer = network.resolver
  const schemaUid = network.schemaUid
  const now = BigInt(Math.floor(Date.now() / 1000))
  const [head, lastOperation, totals, processed, minimums] = await Promise.all([
    db.query.easImportSyncHead.findFirst({
      where: eq(easImportSyncHead.chainId, network.chainId),
    }),
    db
      .select({ block: max(easImportOperation.blockNumber) })
      .from(easImportOperation)
      .where(eq(easImportOperation.importer, importer))
      .then(([row]) => row?.block ?? null),
    Promise.all(
      [0, 1, 2].map((kind) => canonicalCount(schemaUid, kind as 0 | 1 | 2, now))
    ),
    Promise.all(
      [0, 1, 2].map((kind) => importedCount(importer, kind as 0 | 1 | 2))
    ),
    Promise.all(
      [0, 1, 2].map((kind) =>
        pendingMinimum(importer, schemaUid, kind as 0 | 1 | 2, now)
      )
    ),
  ])
  const pending = totals.map((total, index) =>
    Math.max(0, total - processed[index]!)
  )
  const earliestPending = minimums
    .filter((block): block is bigint => block !== null)
    .reduce<
      bigint | null
    >((lowest, block) => (lowest === null || block < lowest ? block : lowest), null)
  const watermark =
    earliestPending === null
      ? (head?.blockNumber ?? null)
      : earliestPending > 0n
        ? earliestPending - 1n
        : 0n

  return c.json({
    instanceId,
    lane: {
      eas: network.importedEas,
      importer,
      router: network.importedRouter,
      schemaUid,
    },
    progress: {
      attestations: {
        total: totals[0],
        processed: processed[0],
        pending: pending[0],
      },
      revocations: {
        total: totals[1],
        processed: processed[1],
        pending: pending[1],
      },
      expirations: {
        total: totals[2],
        processed: processed[2],
        pending: pending[2],
      },
    },
    indexedHead: head
      ? {
          block: head.blockNumber.toString(),
          timestamp: head.timestamp.toString(),
        }
      : null,
    coverageWatermarkBlock: watermark?.toString() ?? null,
    lastImportBlock: lastOperation?.toString() ?? null,
    sweepHealth: pending.some((value) => value > 0)
      ? 'pending'
      : head
        ? 'caught-up'
        : 'not-observed',
    completeness:
      'Checkpoint-complete when the permissionless sweep is live; anyone can import a missing UID.',
  })
})

export default app
