import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseCompositionDraft, parseWeightedDraft } from './advanced-draft'

const word = `0x${'12'.repeat(32)}`
const options = {
  salt: word,
  name: 'Community',
  profile: {
    description: 'Our purpose',
    criteria: '',
    image: '',
    applicationUrl: '',
  },
  withFund: true,
  fundToken: 'other',
  fundTokenAddress: 'partially entered',
  withGovernance: true,
  prepayEth: '0.',
  maxPerRootUsd: '1',
}
const weighted = {
  ...options,
  format: 'csv',
  sourceText: 'account,weight\nunfinished',
  sourceUri: '',
  author: '',
  license: '',
  transform: '',
  cadence: 'fastest',
  instanceId: '',
  binaryInstanceId: '',
}
const composition = {
  ...options,
  outputPool: '',
  epochLength: '0',
  sources: [
    {
      instanceId: word,
      weight: '500000000000000000',
      familyId: word,
      maxAgeBlocks: '1000',
    },
  ],
}

test('weighted drafts retain unfinished editable input and salt, stripping artifacts and signatures', () => {
  assert.deepEqual(
    parseWeightedDraft({
      ...weighted,
      artifacts: { priorRoot: word },
      sourceBytes: [1, 2],
      preview: { success: true },
      simulatedPayload: word,
      pinnedMetadata: { uri: 'ipfs://old' },
      authority: { authorized: true },
    }),
    weighted
  )
})

test('composition drafts retain source choices, never source proofs, adapters, or cached previews', () => {
  assert.deepEqual(
    parseCompositionDraft({
      ...composition,
      preview: { captureBlock: '1' },
      simulatedPayloadHash: word,
      sources: composition.sources.map((source) => ({
        ...source,
        entries: [{ value: '100' }],
        outputRoot: word,
        adapter: '0xold',
        available: true,
        deploymentProvenance: word,
      })),
    }),
    composition
  )
})

test('draft parsing rejects malformed salts, invalid source choices, duplicate sources, and incompatible shapes', () => {
  assert.equal(parseWeightedDraft({ ...weighted, salt: 'invalid' }), null)
  assert.equal(parseWeightedDraft({ ...weighted, format: 'executable' }), null)
  assert.equal(parseWeightedDraft({ ...weighted, profile: null }), null)
  assert.equal(
    parseCompositionDraft({
      ...composition,
      sources: [{ ...composition.sources[0], weight: '-1' }],
    }),
    null
  )
  assert.equal(
    parseCompositionDraft({
      ...composition,
      sources: [composition.sources[0], composition.sources[0]],
    }),
    null
  )
  assert.equal(
    parseCompositionDraft({
      ...composition,
      sources: [{ ...composition.sources[0], instanceId: 'not a network' }],
    }),
    null
  )
})
