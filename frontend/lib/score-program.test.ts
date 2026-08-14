import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SCORE_OUTPUT_DOMAIN_IDS,
  SCORE_PROGRAM_IDS,
  parseScoreKeyDomainProvenance,
  parseScoreProgramProvenance,
} from './score-program'

const provenance = {
  programId: SCORE_PROGRAM_IDS.hypercerts,
  programName: 'hypercerts' as const,
  outputDomain: SCORE_OUTPUT_DOMAIN_IDS['hypercerts-node-v1'],
  outputDomainName: 'hypercerts-node-v1' as const,
  keyEncoding: 'bytes32' as const,
  instanceId: `0x${'01'.repeat(32)}` as const,
  verifier: `0x${'02'.repeat(20)}` as const,
  registryOrAccumulator: `0x${'03'.repeat(20)}` as const,
  paramsHash: `0x${'04'.repeat(32)}` as const,
  source: {
    kind: 'instance-registered',
    registry: `0x${'05'.repeat(20)}` as const,
    blockNumber: '10',
    logIndex: 3,
    transactionHash: `0x${'06'.repeat(32)}` as const,
  },
}

test('rolling responses with extra fields are accepted after the indexer-first deploy', () => {
  assert.equal(
    parseScoreProgramProvenance(
      { ...provenance, futureField: true },
      'hypercerts'
    ).programName,
    'hypercerts'
  )
  assert.equal(
    parseScoreProgramProvenance({
      ...provenance,
      source: {
        ...provenance.source,
        kind: 'instance-params-hash-updated',
      },
    }).source.kind,
    'instance-params-hash-updated'
  )
})

test('a new frontend fails closed against an old or mismatched indexer response', () => {
  assert.throws(
    () => parseScoreProgramProvenance(undefined, 'hypercerts'),
    /missing authenticated program provenance/
  )
  assert.throws(
    () => parseScoreProgramProvenance(provenance, 'agent-reputation'),
    /program mismatch/
  )
  assert.throws(
    () =>
      parseScoreProgramProvenance({
        ...provenance,
        outputDomain: SCORE_OUTPUT_DOMAIN_IDS['erc8004-agent-v1'],
      }),
    /program\/output domain mismatch/
  )
  assert.throws(
    () =>
      parseScoreProgramProvenance({
        ...provenance,
        verifier: '0x1234',
      }),
    /malformed program provenance/
  )
})

test('secondary bytes32 API keys require their semantic domain too', () => {
  assert.equal(
    parseScoreKeyDomainProvenance(
      {
        outputDomain: SCORE_OUTPUT_DOMAIN_IDS['contributions-claim-v1'],
        outputDomainName: 'contributions-claim-v1',
        keyEncoding: 'bytes32',
      },
      'contributions',
      'contributions-claim-v1'
    ).name,
    'contributions-claim-v1'
  )
  assert.throws(
    () =>
      parseScoreKeyDomainProvenance(
        {
          outputDomain: SCORE_OUTPUT_DOMAIN_IDS['hypercerts-node-v1'],
          outputDomainName: 'hypercerts-node-v1',
          keyEncoding: 'bytes32',
        },
        'contributions',
        'contributions-claim-v1'
      ),
    /not served by the contributions API/
  )
})
