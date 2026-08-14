import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SCORE_OUTPUT_DOMAIN_IDS,
  SCORE_PROGRAM_IDS,
  requireScoreApi,
  requireScoreKeyDomain,
  requireScoreProgram,
  validateScoreBlob,
} from './score-program.ts'

const addressKey = `0x${'11'.repeat(20)}`
// Deliberately identical-looking bytes in two incompatible 32-byte semantic domains.
const bytes32Key = `0x${'11'.repeat(32)}`

test('authenticated declarations route colliding-looking keys only to declared surfaces', () => {
  const trust = requireScoreProgram(
    SCORE_PROGRAM_IDS['trust-graph'],
    SCORE_OUTPUT_DOMAIN_IDS['trust-graph-account-v1']
  )
  const contributions = requireScoreProgram(
    SCORE_PROGRAM_IDS.contributions,
    SCORE_OUTPUT_DOMAIN_IDS['contributions-recipient-v1']
  )
  const hypercerts = requireScoreProgram(
    SCORE_PROGRAM_IDS.hypercerts,
    SCORE_OUTPUT_DOMAIN_IDS['hypercerts-node-v1']
  )
  const agent = requireScoreProgram(
    SCORE_PROGRAM_IDS['agent-reputation'],
    SCORE_OUTPUT_DOMAIN_IDS['erc8004-agent-v1']
  )

  assert.deepEqual(validateScoreBlob({ [addressKey]: '1' }, trust), {
    [addressKey]: '1',
  })
  assert.deepEqual(validateScoreBlob({ [addressKey]: '2' }, contributions), {
    [addressKey]: '2',
  })
  assert.deepEqual(validateScoreBlob({ [bytes32Key]: '3' }, hypercerts), {
    [bytes32Key]: '3',
  })
  assert.deepEqual(validateScoreBlob({ [bytes32Key]: '4' }, agent), {
    [bytes32Key]: '4',
  })

  assert.equal(trust.ingestion, 'address-merkle')
  assert.deepEqual(trust.tables, [
    'offchain.merkle_metadata',
    'offchain.merkle_entry',
  ])
  assert.equal(contributions.ingestion, 'contributions')
  assert.ok(contributions.tables.includes('offchain.contribution_score'))
  assert.equal(hypercerts.ingestion, 'hypercerts')
  assert.deepEqual(hypercerts.tables, [
    'offchain.hypercerts_metadata',
    'offchain.hypercerts_score',
  ])
  assert.equal(agent.ingestion, 'not-enabled')
  assert.deepEqual(agent.tables, [])

  assert.equal(
    requireScoreApi(trust.programId, trust.outputDomain, 'merkle').name,
    'trust-graph'
  )
  assert.equal(
    requireScoreApi(
      contributions.programId,
      contributions.outputDomain,
      'contributions'
    ).name,
    'contributions'
  )
  assert.equal(
    requireScoreApi(hypercerts.programId, hypercerts.outputDomain, 'hypercerts')
      .name,
    'hypercerts'
  )
  assert.equal(
    requireScoreApi(agent.programId, agent.outputDomain, 'agent-reputation')
      .name,
    'agent-reputation'
  )

  assert.throws(
    () => requireScoreApi(agent.programId, agent.outputDomain, 'hypercerts'),
    /not served by the hypercerts API/
  )
  assert.throws(
    () => validateScoreBlob({ [bytes32Key]: '1' }, trust),
    /not canonical eip155-address/
  )
  assert.throws(
    () => validateScoreBlob({ [addressKey]: '1' }, hypercerts),
    /not canonical bytes32/
  )
})

test('unknown programs and inconsistent program/domain pairs fail closed', () => {
  assert.throws(
    () =>
      requireScoreProgram(
        `0x${'ff'.repeat(32)}`,
        SCORE_OUTPUT_DOMAIN_IDS['hypercerts-node-v1']
      ),
    /unknown score program/
  )
  assert.throws(
    () =>
      requireScoreProgram(
        SCORE_PROGRAM_IDS.hypercerts,
        SCORE_OUTPUT_DOMAIN_IDS['erc8004-agent-v1']
      ),
    /program\/output domain mismatch/
  )
})

test('all semantic output-domain discriminators are distinct bytes32 values', () => {
  const domains = Object.values(SCORE_OUTPUT_DOMAIN_IDS)
  assert.ok(domains.length >= 3)
  assert.equal(
    new Set(domains.map((domain) => domain.toLowerCase())).size,
    domains.length
  )
  for (const domain of domains) assert.match(domain, /^0x[0-9a-f]{64}$/)
})

test('three colliding-looking bytes32 subjects retain distinct table and API domains', () => {
  const claim = requireScoreKeyDomain(
    SCORE_OUTPUT_DOMAIN_IDS['contributions-claim-v1'],
    'contributions'
  )
  const node = requireScoreKeyDomain(
    SCORE_OUTPUT_DOMAIN_IDS['hypercerts-node-v1'],
    'hypercerts'
  )
  const agent = requireScoreKeyDomain(
    SCORE_OUTPUT_DOMAIN_IDS['erc8004-agent-v1'],
    'agent-reputation'
  )
  for (const domain of [claim, node, agent]) {
    assert.equal(domain.keyEncoding, 'bytes32')
    assert.match(bytes32Key, /^0x[0-9a-f]{64}$/)
  }
  assert.deepEqual(claim.tables, [
    'offchain.contribution_score',
    'offchain.contribution_valuation_audit',
  ])
  assert.deepEqual(node.tables, ['offchain.hypercerts_score'])
  assert.deepEqual(agent.tables, [])
  assert.equal(new Set([claim.id, node.id, agent.id]).size, 3)
  assert.throws(
    () => requireScoreKeyDomain(agent.id, 'hypercerts'),
    /not served by the hypercerts API/
  )
})
