import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseCreationDraft } from './draft'

const valid = {
  step: 3,
  salt: `0x${'ab'.repeat(32)}`,
  data: {
    name: 'Community',
    description: 'Our purpose',
    criteria: '',
    image: '',
    applicationUrl: '',
    seeds: [`0x${'11'.repeat(20)}`],
    seedNames: {},
    tuning: {
      vouchWeightPct: 85,
      headStartPct: 100,
      headStartKeptPct: 80,
      totalPoints: 1000000,
      cadence: 'fastest',
    },
    withFund: true,
    fundToken: 'other',
    fundTokenAddress: '',
    prepayEth: '0.1',
    maxPerRootUsd: '1',
    withSignerSync: false,
    withOffchainVouches: false,
    offchainMaxTotalInputs: 200000,
    signerTopN: 5,
    signerMinThreshold: 2,
    signerTargetThresholdPct: 50,
    subnetworkTier: 'admin',
  },
}

test('creation draft roundtrips editable fields and salt, discarding cached authorization', () => {
  assert.deepEqual(
    parseCreationDraft(
      JSON.parse(
        JSON.stringify({
          ...valid,
          simulationPassed: true,
          metadataUri: 'ipfs://stale',
        })
      )
    ),
    valid
  )
})

test('malformed or incompatible drafts cannot reach the creation model', () => {
  for (const value of [
    null,
    {},
    { ...valid, step: 99 },
    { ...valid, salt: '0x' },
    { ...valid, data: { ...valid.data, seeds: ['bad address'] } },
    {
      ...valid,
      data: {
        ...valid.data,
        tuning: { ...valid.data.tuning, totalPoints: Infinity },
      },
    },
  ]) {
    assert.equal(parseCreationDraft(value), null)
  }
})
