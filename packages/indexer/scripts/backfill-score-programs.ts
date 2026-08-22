#!/usr/bin/env tsx
/**
 * Audited one-shot repair for offchain score rows written before program provenance existed.
 *
 * Dry-run by default:
 *   pnpm programs:backfill
 * Apply after the new indexer has replayed InstanceRegistry events:
 *   pnpm programs:backfill --apply
 */
import { sql } from 'drizzle-orm'

import * as schema from '../offchain.schema'
import { offchainDb, offchainPool } from '../src/api/db'
import {
  type ScoreProgramDefinition,
  type ScoreProgramProvenance,
  parseScoreProgramProvenance,
  requireScoreProgram,
} from '../src/score-program'
import {
  scoreBackfillFamilies,
  scoreRowDiscriminators,
} from '../src/score-program-backfill'

const apply = process.argv.includes('--apply')
const api = (process.env.PONDER_API_URL ?? 'http://127.0.0.1:42069').replace(
  /\/+$/,
  ''
)

const run = async () => {
  const snapshots = new Set<string>()
  for (const table of [
    schema.merkleMetadata,
    schema.hypercertsMetadata,
    schema.contributionRound,
  ]) {
    const rows = await offchainDb
      .selectDistinct({ snapshot: table.merkleSnapshotContract })
      .from(table)
    for (const row of rows) snapshots.add(row.snapshot.toLowerCase())
  }

  const plans: Array<{
    snapshot: string
    provenance: ScoreProgramProvenance
    program: ScoreProgramDefinition
    families: ReturnType<typeof scoreBackfillFamilies>
  }> = []
  for (const snapshot of [...snapshots].sort()) {
    const response = await fetch(`${api}/score-programs/${snapshot}`)
    if (!response.ok) {
      throw new Error(
        `binding lookup for ${snapshot} failed closed: ${response.status} ${await response.text()}`
      )
    }
    const body = (await response.json()) as { scoreProgram?: unknown }
    const provenance = parseScoreProgramProvenance(body.scoreProgram)
    const program = requireScoreProgram(
      provenance.programId,
      provenance.outputDomain
    )
    plans.push({
      snapshot,
      provenance,
      program,
      families: scoreBackfillFamilies(program),
    })
  }

  for (const plan of plans) {
    console.log(
      `${apply ? 'APPLY' : 'DRY-RUN'} ${plan.snapshot} ${plan.program.name}/${plan.program.outputDomainName}: ${plan.families.join(', ')}`
    )
  }

  if (apply) {
    const compositions = plans.filter((plan) =>
      plan.families.includes('composition')
    )
    if (compositions.length > 0) {
      throw new Error(
        `refusing discriminator-only backfill for ${compositions.length} trust-compose snapshot(s); ` +
          'replay their factory, capture, source blobs, proof, and accepted state through live ingestion'
      )
    }
    await offchainDb.transaction(async (tx) => {
      for (const plan of plans) {
        const discriminators = scoreRowDiscriminators(plan.program)
        if (plan.families.includes('address-merkle')) {
          await tx
            .update(schema.merkleMetadata)
            .set({
              ...discriminators.primary,
              programProvenance: plan.provenance,
            })
            .where(
              sql`lower(${schema.merkleMetadata.merkleSnapshotContract}) = ${plan.snapshot}`
            )
          await tx
            .update(schema.merkleEntry)
            .set(discriminators.primary)
            .where(
              sql`lower(${schema.merkleEntry.merkleSnapshotContract}) = ${plan.snapshot}`
            )
        }
        if (plan.families.includes('hypercerts')) {
          await tx
            .update(schema.hypercertsMetadata)
            .set({
              ...discriminators.primary,
              programProvenance: plan.provenance,
            })
            .where(
              sql`lower(${schema.hypercertsMetadata.merkleSnapshotContract}) = ${plan.snapshot}`
            )
          await tx
            .update(schema.hypercertsScore)
            .set(discriminators.primary)
            .where(
              sql`lower(${schema.hypercertsScore.merkleSnapshotContract}) = ${plan.snapshot}`
            )
        }
        if (plan.families.includes('contributions')) {
          await tx
            .update(schema.contributionRound)
            .set({
              ...discriminators.primary,
              programProvenance: plan.provenance,
            })
            .where(
              sql`lower(${schema.contributionRound.merkleSnapshotContract}) = ${plan.snapshot}`
            )
          await tx
            .update(schema.contributionScore)
            .set(discriminators.claim!)
            .where(
              sql`lower(${schema.contributionScore.merkleSnapshotContract}) = ${plan.snapshot}`
            )
          await tx
            .update(schema.contributionValuationAudit)
            .set(discriminators.claim!)
            .where(
              sql`lower(${schema.contributionValuationAudit.merkleSnapshotContract}) = ${plan.snapshot}`
            )
        }
      }
    })
  }

  console.log(
    `${apply ? 'Backfilled' : 'Audited'} ${plans.length} snapshot(s).`
  )
}

try {
  await run()
} finally {
  await offchainPool.end()
}
