import { and, count, desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from 'ponder:api'
import { scoreProgramBinding } from 'ponder:schema'

import {
  SCORE_PROGRAMS,
  type ScoreApi,
  type ScoreProgramName,
  type ScoreProgramProvenance,
  parseScoreProgramProvenance,
  requireScoreApi,
  requireScoreProgram,
  requireScoreProgramSourceKind,
} from '../score-program'

export class ScoreProgramApiError extends Error {}

const bindingForSnapshot = async (snapshot: string) => {
  const [binding] = await db
    .select()
    .from(scoreProgramBinding)
    .where(
      sql`lower(${scoreProgramBinding.snapshot}) = ${snapshot.toLowerCase()}`
    )
    .limit(1)
  return binding
}

export const serializeScoreProgramBinding = (
  binding: NonNullable<Awaited<ReturnType<typeof bindingForSnapshot>>>
): ScoreProgramProvenance => {
  if (binding.conflict) {
    throw new ScoreProgramApiError(
      `snapshot has a conflicting score-program binding: ${binding.conflictReason}`
    )
  }
  if (!binding.outputDomain) {
    throw new ScoreProgramApiError(
      `snapshot uses unknown score program ${binding.programId}`
    )
  }
  let definition
  let sourceKind
  try {
    definition = requireScoreProgram(binding.programId, binding.outputDomain)
    sourceKind = requireScoreProgramSourceKind(binding.sourceKind)
  } catch (error) {
    throw new ScoreProgramApiError(
      error instanceof Error ? error.message : String(error)
    )
  }
  return {
    programId: binding.programId,
    programName: definition.name,
    outputDomain: binding.outputDomain,
    outputDomainName: definition.outputDomainName,
    keyEncoding: definition.keyEncoding,
    instanceId: binding.instanceId,
    verifier: binding.verifier,
    registryOrAccumulator: binding.registryOrAccumulator,
    paramsHash: binding.paramsHash,
    source: {
      kind: sourceKind,
      registry: binding.sourceRegistry,
      blockNumber: binding.sourceBlock.toString(),
      logIndex: binding.sourceLogIndex,
      transactionHash: binding.sourceTxHash,
    },
  }
}

/** Require the on-chain binding to authorize this API namespace. */
export const requireSnapshotScoreProgram = async (
  snapshot: string,
  api?: ScoreApi
): Promise<ScoreProgramProvenance> => {
  const binding = await bindingForSnapshot(snapshot)
  if (!binding) {
    throw new ScoreProgramApiError(
      `snapshot ${snapshot} has no authenticated score-program binding`
    )
  }
  const serialized = serializeScoreProgramBinding(binding)
  if (api) {
    try {
      requireScoreApi(serialized.programId, serialized.outputDomain, api)
    } catch (error) {
      throw new ScoreProgramApiError(
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  return serialized
}

/** Require a historical offchain row to carry the same immutable program/domain identity. */
export const requireRowScoreProgram = (
  row: {
    programId: string | null
    outputDomain: string | null
    programProvenance?: Record<string, unknown> | null
  },
  current: ScoreProgramProvenance,
  api: ScoreApi
): ScoreProgramProvenance => {
  if (!row.programId || !row.outputDomain || !row.programProvenance) {
    throw new ScoreProgramApiError(
      'historical score row has not completed the program-provenance backfill'
    )
  }
  try {
    requireScoreApi(row.programId, row.outputDomain, api)
  } catch (error) {
    throw new ScoreProgramApiError(
      error instanceof Error ? error.message : String(error)
    )
  }
  if (
    row.programId.toLowerCase() !== current.programId.toLowerCase() ||
    row.outputDomain.toLowerCase() !== current.outputDomain.toLowerCase()
  ) {
    throw new ScoreProgramApiError(
      'historical score row conflicts with the authenticated snapshot binding'
    )
  }
  try {
    const historical = parseScoreProgramProvenance(row.programProvenance)
    if (
      historical.programId.toLowerCase() !== row.programId.toLowerCase() ||
      historical.outputDomain.toLowerCase() !== row.outputDomain.toLowerCase()
    ) {
      throw new Error(
        'historical provenance conflicts with its row discriminator columns'
      )
    }
    return historical
  } catch (error) {
    throw new ScoreProgramApiError(
      error instanceof Error ? error.message : String(error)
    )
  }
}

export const requireEntryScoreProgram = (
  row: { programId: string | null; outputDomain: string | null },
  current: ScoreProgramProvenance
) => {
  if (
    !row.programId ||
    !row.outputDomain ||
    row.programId.toLowerCase() !== current.programId.toLowerCase() ||
    row.outputDomain.toLowerCase() !== current.outputDomain.toLowerCase()
  ) {
    throw new ScoreProgramApiError(
      'score entry has an unknown or mismatched program/output domain'
    )
  }
}

const app = new Hono()

const DEFAULT_CATALOG_LIMIT = 50
const MAX_CATALOG_LIMIT = 200

const catalogInteger = (
  raw: string | undefined,
  fallback: number,
  maximum: number
) => {
  if (raw === undefined) return fallback
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) return null
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) return null
  return Math.min(value, maximum)
}

/**
 * List current and historical authenticated bindings for one known program. This is the discovery
 * seam for non-factory programs: rows originate only in InstanceRegistry events, and unknown or
 * conflicted identities never become catalog entries.
 */
app.get('/', async (c) => {
  const requested = c.req.query('program') as ScoreProgramName | undefined
  const program = SCORE_PROGRAMS.find(
    (candidate) => candidate.name === requested
  )
  const limit = catalogInteger(
    c.req.query('limit'),
    DEFAULT_CATALOG_LIMIT,
    MAX_CATALOG_LIMIT
  )
  const offset = catalogInteger(
    c.req.query('offset'),
    0,
    Number.MAX_SAFE_INTEGER
  )
  if (!program) {
    return c.json({ error: 'program must name a known score program' }, 400)
  }
  if (limit === null || offset === null) {
    return c.json(
      { error: 'limit and offset must be non-negative integers' },
      400
    )
  }

  const where = and(
    eq(scoreProgramBinding.programId, program.programId),
    eq(scoreProgramBinding.outputDomain, program.outputDomain),
    eq(scoreProgramBinding.conflict, false)
  )
  const [bindings, totals] = await Promise.all([
    db
      .select()
      .from(scoreProgramBinding)
      .where(where)
      .orderBy(
        desc(scoreProgramBinding.sourceBlock),
        desc(scoreProgramBinding.sourceLogIndex)
      )
      .limit(limit)
      .offset(offset),
    db
      .select({ value: count(scoreProgramBinding.id) })
      .from(scoreProgramBinding)
      .where(where),
  ])

  return c.json({
    bindings: bindings.map((binding) => ({
      snapshot: binding.snapshot,
      scoreProgram: serializeScoreProgramBinding(binding),
    })),
    pagination: { limit, offset, total: totals[0]?.value ?? 0 },
  })
})

app.get('/:snapshot', async (c) => {
  try {
    const scoreProgram = await requireSnapshotScoreProgram(
      c.req.param('snapshot')
    )
    return c.json({ scoreProgram })
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return c.json({ error: error.message }, 409)
    }
    throw error
  }
})

export default app
