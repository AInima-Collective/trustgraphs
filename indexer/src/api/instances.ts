/**
 * Trust-graph instance catalog (GOAL.md M2; research/INSTANCE_FACTORY.md §3).
 *
 * Serves the `instance` table — one row per network created through `TrustgraphsFactory`, built from
 * the frozen `InstanceCreated` event (src/factory.ts). This is what REPLACES `config/networks.json`
 * for trust-graph networks: the app asks the chain (via this route) which networks exist instead of
 * shipping a list, so a community that signed `createInstance` a minute ago is browsable with no
 * config edit, no redeploy and no restart.
 *
 * The response is shaped for a TS client (frontend/lib/types.ts `Network`) and needs no post-
 * processing: addresses arrive under `contracts` with the names the frontend uses, the vouch schema
 * arrives as a ready `NetworkSchema` (uid + parsed fields), and every on-chain bigint arrives as a
 * decimal string. `params` is the FULL 17-field struct as emitted — fixed-point, not rescaled: the
 * `*Fp` fields are scaled by `params.precisionScale` (1e18) and `totalPool` is the raw pool. The
 * canonical fixed-point → display conversion lives in frontend/lib/pagerank; doing it here would
 * fork it.
 *
 * `paramsHash` is recomputed by the indexer from those exact fields and always equals
 * `MerkleSnapshot(contracts.merkleSnapshot).paramsHash()` — a client that cares can verify this
 * response against the chain in one `eth_call` and ignore this endpoint entirely.
 *
 * Routes:
 *   GET /instances                    the catalog, newest first, paginated
 *     ?limit= (default 50, max 200) &offset=
 *     &creator= &admin= &snapshot= &resolver= &distributor= &schemaUid=   (exact-match filters)
 *   GET /instances/:id                one instance by its `instanceId`
 */
import { and, count, desc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from 'ponder:api'
import {
  instance,
  merkleGovModule,
  parameterVersion,
  signerSyncModule,
  signerSyncRotation,
} from 'ponder:schema'
import { type Hex, isAddress, isHex } from 'viem'

import type { InstanceParamsJson } from '../factory'
import { deriveParameterVersionStates } from '../params-shared'

const app = new Hono()

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

type InstanceRow = typeof instance.$inferSelect
type GovernanceRow = Pick<
  typeof merkleGovModule.$inferSelect,
  'address' | 'merkleSnapshot' | 'target'
>
type SignerRow = typeof signerSyncModule.$inferSelect
type SignerRotationRow = typeof signerSyncRotation.$inferSelect
type SignerView = SignerRow & { lastRotation?: SignerRotationRow }

/**
 * The canonical vouch schema's presentation labels. Every factory instance shares one schema
 * (`TrustgraphsFactory.VOUCH_SCHEMA`) precisely so these are uniform — a creator-customizable schema
 * would fork `weightFieldIndex` and multiply the surface every consumer has to handle.
 */
const VOUCH_SCHEMA_KEY = 'vouching'
const VOUCH_SCHEMA_NAME = 'Vouch'
const VOUCH_SCHEMA_DESCRIPTION = 'Weighted endorsement'

/** `"string comment,uint256 confidence"` → `[{name: 'comment', type: 'string'}, …]`. */
const parseSchemaFields = (schema: string) =>
  schema
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field.length > 0)
    .map((field) => {
      const [type, name] = field.split(/\s+/)
      return { name: name ?? '', type: type ?? '' }
    })

const serialize = (
  row: InstanceRow,
  governance?: GovernanceRow,
  signer?: SignerView
) => ({
  id: row.id,
  chainId: row.chainId,
  factory: row.factory,
  creator: row.creator,
  admin: row.admin,
  name: row.name,
  metadataURI: row.metadataURI,
  // The presentation blob `{name, description, criteria, image, applicationUrl}`, or null when the
  // instance shipped no URI (or it could not be resolved). Nothing here is consensus-relevant.
  metadata: row.metadata ?? null,
  contracts: {
    merkleSnapshot: row.snapshot,
    easIndexerResolver: row.resolver,
    merkleFundDistributor: row.distributor,
    trustgraphsParamsController: row.paramsController,
    merkleGovModule: governance?.address ?? null,
    safe:
      governance || signer
        ? {
            proxy: governance?.target ?? signer!.safe,
            signerSyncManager: signer?.address ?? null,
          }
        : null,
  },
  signerSync: signer
    ? {
        operatorInstanceId: signer.operatorInstanceId,
        module: signer.address,
        safe: signer.safe,
        scoreSnapshot: signer.scoreSnapshot,
        accumulator: signer.accumulator,
        verifier: signer.verifier,
        programVKey: signer.programVKey,
        selectionParamsHash: signer.selectionParamsHash,
        topN: signer.topN,
        minThreshold: signer.minThreshold,
        targetThresholdBps: signer.targetThresholdBps,
        paused: signer.paused,
        safeModuleEnabled: signer.safeModuleEnabled,
        hasAppliedCheckpoint: signer.hasAppliedCheckpoint,
        lastAppliedCheckpoint: signer.lastAppliedCheckpoint?.toString() ?? null,
        lastSyncedBlock: signer.lastSyncedBlock?.toString() ?? null,
        lastSyncedTimestamp: signer.lastSyncedTimestamp?.toString() ?? null,
        lastSyncedTxHash: signer.lastSyncedTxHash,
        lastRotation: signer.lastRotation
          ? {
              checkpointId: signer.lastRotation.checkpointId.toString(),
              signerSetRoot: signer.lastRotation.signerSetRoot,
              threshold: signer.lastRotation.threshold.toString(),
              submitter: signer.lastRotation.submitter,
              signers: signer.lastRotation.signers,
              blockNumber: signer.lastRotation.blockNumber.toString(),
              timestamp: signer.lastRotation.timestamp.toString(),
              txHash: signer.lastRotation.txHash,
            }
          : null,
      }
    : null,
  // Ready to drop into `Network['schemas']`.
  schema: {
    uid: row.schemaUid,
    key: VOUCH_SCHEMA_KEY,
    name: VOUCH_SCHEMA_NAME,
    description: VOUCH_SCHEMA_DESCRIPTION,
    schema: row.schemaString,
    resolver: row.resolver,
    // The factory always registers the vouch schema revocable (a vouch you cannot withdraw is not
    // a vouch).
    revocable: true,
    fields: parseSchemaFields(row.schemaString),
  },
  // The token the community intends to distribute — the payout screen's default pick, not a
  // restriction (the distributor is multi-token).
  distributorToken: row.distributorToken,
  epochLength: row.epochLength.toString(),
  paramsHash: row.paramsHash,
  params: row.params as InstanceParamsJson,
  paramsControl: row.paramsController ? 'typed' : 'legacy',
  paramsVersion: row.paramsVersion?.toString() ?? null,
  paramsState: row.paramsController
    ? row.paramsFirstCheckpoint === null
      ? 'current-unpinned'
      : 'active'
    : null,
  paramsExecutedAtBlock: row.paramsExecutedAtBlock?.toString() ?? null,
  paramsExecutedTimestamp: row.paramsExecutedTimestamp?.toString() ?? null,
  paramsExecutedTxHash: row.paramsExecutedTxHash,
  paramsFirstCheckpoint: row.paramsFirstCheckpoint?.toString() ?? null,
  trustedSeeds: row.trustedSeeds,
  createdBlock: row.createdBlock.toString(),
  createdTimestamp: row.createdTimestamp.toString(),
  createdTxHash: row.createdTxHash,
})

const governanceFor = async (rows: InstanceRow[]) => {
  if (rows.length === 0) return new Map<string, GovernanceRow>()

  const governanceRows = await db
    .select({
      address: merkleGovModule.address,
      merkleSnapshot: merkleGovModule.merkleSnapshot,
      target: merkleGovModule.target,
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

const signerSyncFor = async (rows: InstanceRow[]) => {
  if (rows.length === 0) return new Map<string, SignerView>()
  const ids = rows.map((row) => row.id)
  const [modules, rotations] = await Promise.all([
    db
      .select()
      .from(signerSyncModule)
      .where(inArray(signerSyncModule.instanceId, ids)),
    db
      .select()
      .from(signerSyncRotation)
      .where(inArray(signerSyncRotation.instanceId, ids))
      .orderBy(
        desc(signerSyncRotation.blockNumber),
        desc(signerSyncRotation.id)
      ),
  ])
  const latest = new Map<string, SignerRotationRow>()
  for (const rotation of rotations) {
    const key = rotation.instanceId.toLowerCase()
    if (!latest.has(key)) latest.set(key, rotation)
  }
  return new Map(
    modules.map((module) => [
      module.instanceId.toLowerCase(),
      {
        ...module,
        lastRotation: latest.get(module.instanceId.toLowerCase()),
      },
    ])
  )
}

/** Parse a bounded non-negative integer query param. */
const intParam = (raw: string | undefined, fallback: number, max: number) => {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) return null
  return Math.min(value, max)
}

app.get('/', async (c) => {
  const limit = intParam(c.req.query('limit'), DEFAULT_LIMIT, MAX_LIMIT)
  const offset = intParam(c.req.query('offset'), 0, Number.MAX_SAFE_INTEGER)
  if (limit === null || offset === null) {
    return c.json(
      { error: 'limit and offset must be non-negative integers' },
      400
    )
  }

  const filters = []
  for (const [param, column] of [
    ['creator', instance.creator],
    ['admin', instance.admin],
    ['snapshot', instance.snapshot],
    ['resolver', instance.resolver],
    ['distributor', instance.distributor],
  ] as const) {
    const value = c.req.query(param)
    if (value === undefined) continue
    if (!isAddress(value)) {
      return c.json({ error: `${param} must be an address` }, 400)
    }
    // Addresses are stored checksummed as they arrive from the event; compare case-insensitively.
    filters.push(eq(column, value as Hex))
  }
  const schemaUid = c.req.query('schemaUid')
  if (schemaUid !== undefined) {
    if (!isHex(schemaUid) || schemaUid.length !== 66) {
      return c.json({ error: 'schemaUid must be a 32-byte hex string' }, 400)
    }
    filters.push(eq(instance.schemaUid, schemaUid))
  }
  const where = filters.length > 0 ? and(...filters) : undefined

  try {
    const rows = await db
      .select()
      .from(instance)
      .where(where)
      .orderBy(desc(instance.createdBlock), desc(instance.id))
      .limit(limit)
      .offset(offset)

    const [totalRow] = await db
      .select({ total: count(instance.id) })
      .from(instance)
      .where(where)

    const [governance, signerSync] = await Promise.all([
      governanceFor(rows),
      signerSyncFor(rows),
    ])

    return c.json({
      instances: rows.map((row) =>
        serialize(
          row,
          governance.get(row.snapshot.toLowerCase()),
          signerSync.get(row.id.toLowerCase())
        )
      ),
      pagination: {
        limit,
        offset,
        total: totalRow?.total ?? 0,
      },
    })
  } catch (error) {
    console.error('Error fetching instances:', error)
    return c.json({ error: 'Failed to fetch instances' }, 500)
  }
})

app.get('/:id/params', async (c) => {
  const id = c.req.param('id')
  if (!isHex(id) || id.length !== 66) {
    return c.json({ error: 'id must be a 32-byte instanceId hex string' }, 400)
  }

  try {
    const [row] = await db
      .select()
      .from(instance)
      .where(eq(instance.id, id))
      .limit(1)
    if (!row) {
      return c.json({ error: 'Instance not found' }, 404)
    }
    const versions = await db
      .select()
      .from(parameterVersion)
      .where(eq(parameterVersion.instanceId, id))
      .orderBy(desc(parameterVersion.version))

    const states = deriveParameterVersionStates(
      versions,
      row.paramsVersion ?? null
    )

    return c.json({
      instanceId: id,
      controller: row.paramsController,
      currentVersion: row.paramsVersion?.toString() ?? null,
      currentParamsHash: row.paramsHash,
      control: row.paramsController ? 'typed' : 'legacy',
      versions: versions.map((version) => ({
        version: version.version.toString(),
        paramsHash: version.paramsHash,
        previousParamsHash: version.previousParamsHash,
        params: version.params as InstanceParamsJson,
        trustedSeeds: version.trustedSeeds,
        evidenceURI: version.evidenceURI,
        executor: version.executor,
        executedAtBlock: version.executedAtBlock.toString(),
        executedTimestamp: version.executedTimestamp.toString(),
        executedTxHash: version.executedTxHash,
        firstCheckpoint: version.firstCheckpoint?.toString() ?? null,
        firstCheckpointBlock: version.firstCheckpointBlock?.toString() ?? null,
        firstCheckpointTimestamp:
          version.firstCheckpointTimestamp?.toString() ?? null,
        firstCheckpointTxHash: version.firstCheckpointTxHash,
        state: states.get(version.version),
        valid: version.valid,
        invalidReason: version.invalidReason,
      })),
    })
  } catch (error) {
    console.error('Error fetching parameter versions:', error)
    return c.json({ error: 'Failed to fetch parameter versions' }, 500)
  }
})

app.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!isHex(id) || id.length !== 66) {
    return c.json({ error: 'id must be a 32-byte instanceId hex string' }, 400)
  }

  try {
    const [row] = await db
      .select()
      .from(instance)
      .where(eq(instance.id, id))
      .limit(1)
    if (!row) {
      return c.json({ error: 'Instance not found' }, 404)
    }
    const [governance, signerSync] = await Promise.all([
      governanceFor([row]),
      signerSyncFor([row]),
    ])
    return c.json({
      instance: serialize(
        row,
        governance.get(row.snapshot.toLowerCase()),
        signerSync.get(row.id.toLowerCase())
      ),
    })
  } catch (error) {
    console.error('Error fetching instance:', error)
    return c.json({ error: 'Failed to fetch instance' }, 500)
  }
})

export default app
