import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canRepairScoreRowsOnRestart,
  scoreBackfillFamilies,
  scoreRowDiscriminators,
} from './score-program-backfill.ts'
import {
  SCORE_OUTPUT_DOMAIN_IDS,
  SCORE_PROGRAM_IDS,
  requireScoreProgram,
} from './score-program.ts'

const program = (
  name: keyof typeof SCORE_PROGRAM_IDS,
  domain: keyof typeof SCORE_OUTPUT_DOMAIN_IDS
) =>
  requireScoreProgram(SCORE_PROGRAM_IDS[name], SCORE_OUTPUT_DOMAIN_IDS[domain])

test('historical repair touches only the authenticated program table families', () => {
  assert.deepEqual(
    scoreBackfillFamilies(program('trust-graph', 'trust-graph-account-v1')),
    ['address-merkle']
  )
  assert.deepEqual(
    scoreBackfillFamilies(
      program('contributions', 'contributions-recipient-v1')
    ),
    ['address-merkle', 'contributions']
  )
  assert.deepEqual(
    scoreBackfillFamilies(program('hypercerts', 'hypercerts-node-v1')),
    ['hypercerts']
  )
  assert.deepEqual(
    scoreBackfillFamilies(program('trust-compose', 'trust-compose-account-v1')),
    ['address-merkle', 'composition']
  )
  assert.throws(
    () =>
      scoreBackfillFamilies(program('agent-reputation', 'erc8004-agent-v1')),
    /production ingestion is not enabled/
  )
})

test('restart repair is idempotent and waits for every contributions surface', () => {
  const contributions = program('contributions', 'contributions-recipient-v1')
  const discriminators = scoreRowDiscriminators(contributions)
  const preexisting = {
    programId: null as string | null,
    outputDomain: null as string | null,
  }
  const repairedOnce = {
    ...preexisting,
    ...discriminators.primary,
  }
  assert.deepEqual({ ...repairedOnce, ...discriminators.primary }, repairedOnce)
  assert.equal(
    canRepairScoreRowsOnRestart(contributions, {
      metadata: true,
      entries: true,
      contributionRound: false,
    }),
    false
  )
  assert.equal(
    canRepairScoreRowsOnRestart(contributions, {
      metadata: true,
      entries: true,
      contributionRound: true,
    }),
    true
  )
  assert.equal(
    discriminators.claim?.outputDomain,
    SCORE_OUTPUT_DOMAIN_IDS['contributions-claim-v1']
  )
})

test('composition restart never skips until its complete verified epoch exists', () => {
  const composition = program('trust-compose', 'trust-compose-account-v1')
  assert.equal(
    canRepairScoreRowsOnRestart(composition, {
      metadata: true,
      entries: true,
      contributionRound: false,
      compositionEpoch: false,
    }),
    false
  )
  assert.equal(
    canRepairScoreRowsOnRestart(composition, {
      metadata: true,
      entries: true,
      contributionRound: false,
      compositionEpoch: true,
    }),
    true
  )
})

test('one-shot backfill source keeps composition behind full replay', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(
    new URL('../scripts/backfill-score-programs.ts', import.meta.url),
    'utf8'
  )
  assert.match(source, /refusing discriminator-only backfill/)
  assert.match(source, /capture, source blobs, proof, and accepted state/)
})
