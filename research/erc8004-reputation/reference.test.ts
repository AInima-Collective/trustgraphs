import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  EXCLUSION_REASONS,
  ReputationExperimentError,
  canonicalExperimentInput,
  canonicalExperimentPolicy,
  type ExperimentInput,
  type ExperimentPolicy,
  type ExperimentResult,
  runExperiment,
  sha256Hex,
} from './reference'

const read = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) as T

const policy = read<ExperimentPolicy>('policy.json')
const input = read<ExperimentInput>('input.json')
const golden = read<ExperimentResult>('golden.json')

test('primary reference reproduces the complete checked-in golden', () => {
  assert.deepEqual(runExperiment(policy, input), golden)
  assert.equal(
    `${canonicalExperimentPolicy(policy)}\n`,
    readFileSync(new URL('canonical-policy.json', import.meta.url), 'utf8')
  )
  assert.equal(
    `${canonicalExperimentInput(input)}\n`,
    readFileSync(new URL('canonical-input.json', import.meta.url), 'utf8')
  )
  assert.equal(
    sha256Hex(canonicalExperimentPolicy(policy)),
    golden.policySha256
  )
  assert.equal(sha256Hex(canonicalExperimentInput(input)), golden.inputSha256)
})

test('enumeration order cannot change the canonical input hash or experiment', () => {
  const reversed = {
    ...input,
    records: [...input.records].reverse(),
  }
  assert.equal(
    canonicalExperimentInput(reversed),
    canonicalExperimentInput(input)
  )
  assert.deepEqual(runExperiment(policy, reversed), golden)
})

test('every excluded record has exactly one stable machine-readable reason', () => {
  assert.equal(golden.decisions.length, input.records.length)
  assert.equal(
    golden.decisions.filter((decision) => decision.included).length,
    golden.metrics.includedRecords
  )
  for (const decision of golden.decisions) {
    assert.equal(decision.included, decision.reason === null)
    assert.ok(
      decision.reason === null || EXCLUSION_REASONS.includes(decision.reason)
    )
  }
  assert.deepEqual(
    Object.values(golden.metrics.excludedByReason),
    EXCLUSION_REASONS.map(() => 1),
    'the representative fixture exercises every exclusion reason once'
  )
})

test('reconciliation preserves responses and revocation history without changing validity', () => {
  const decision = new Map(
    golden.decisions.map((item) => [item.recordId, item])
  )
  assert.equal(decision.get('feedback-01-repeat-old')?.reason, 'superseded')
  assert.equal(
    decision.get('feedback-02-repeat-new-with-response')?.included,
    true
  )
  assert.equal(decision.get('feedback-05-revoked')?.reason, 'revoked')
  assert.deepEqual(golden.metrics.pairReconciliation, {
    supersededRecords: 1,
    revokedRecords: 1,
    includedRecordsWithResponses: 1,
    preservedResponseCount: 2,
  })
})

test('historical wallet rotation is honored while current-state substitution is absent', () => {
  const before = golden.includedPairs.find(
    (pair) => pair.recordId === 'feedback-04-before-wallet-rotation'
  )!
  const after = golden.includedPairs.find(
    (pair) => pair.recordId === 'feedback-06-after-wallet-rotation'
  )!
  assert.notEqual(before.reviewerAgentKey, after.reviewerAgentKey)
  assert.equal(
    input.records.find((record) => record.id === before.recordId)?.reviewer,
    input.records.find((record) => record.id === after.recordId)?.reviewer
  )
  assert.match(policy.historicalAttribution.source, /strictly before/)
  assert.equal(
    policy.historicalAttribution.currentWalletSubstitution,
    'forbidden'
  )
})

test('coverage distinguishes observed zero from missing evidence', () => {
  assert.deepEqual(golden.metrics.coverage, {
    possiblePairs: 28,
    observedPairs: 9,
    missingPairs: 19,
    observedZeroPairs: 1,
    pairCoverageMicros: '321428',
  })
  const observedZero = golden.direct.find((target) =>
    target.targetAgentKey.endsWith(':6')
  )!
  const missing = golden.direct.find((target) =>
    target.targetAgentKey.endsWith(':7')
  )!
  assert.equal(observedZero.scoreMicros, '0')
  assert.equal(observedZero.reviewerCount, 1)
  assert.equal(missing.scoreMicros, null)
  assert.equal(missing.reviewerCount, 0)
})

test('candidate comparison exposes ring amplification and reviewer sensitivity', () => {
  assert.deepEqual(
    golden.direct
      .slice(0, 2)
      .map((target) => target.targetAgentKey.split(':').at(-1)),
    ['4', '5']
  )
  assert.deepEqual(
    golden.propagation.targets
      .slice(0, 2)
      .map((target) => target.agentKey.split(':').at(-1)),
    ['9', '8']
  )
  assert.equal(golden.comparison.reciprocalRingTargetShareMicros, '669419')
  assert.ok(
    golden.leaveOneOut.some(
      (run) => run.targetsLosingAllDirectEvidence.length > 0
    )
  )
  assert.equal(golden.recommendation.decision, 'no-go-for-production-or-proof')
})

test('trust-root, event provenance, and attribution corruption fail closed', () => {
  const wrongRoot = structuredClone(policy)
  wrongRoot.reviewerTrust.root = `0x${'00'.repeat(32)}`
  assert.throws(
    () => runExperiment(wrongRoot, input),
    new ReputationExperimentError('reviewer trust root mismatch')
  )

  const wrongTarget = structuredClone(input)
  wrongTarget.records[0]!.targetAgentKey = policy.targetUniverse[1]!
  assert.throws(() => runExperiment(policy, wrongTarget), /target key/)

  const substituted = structuredClone(input)
  substituted.records.find(
    (record) => record.id === 'feedback-13-unattributed'
  )!.reviewerAgentKey = policy.reviewerTrust.reviewers[0]!.agentKey
  assert.throws(
    () => runExperiment(policy, substituted),
    /substitutes an agent/
  )
})
