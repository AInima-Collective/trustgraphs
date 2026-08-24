import assert from 'node:assert/strict'
import test from 'node:test'

import { type Hex, encodeFunctionData, zeroAddress } from 'viem'

import { weightedManifestFromCalldata } from './weighted-prior-calldata'
import {
  governedWeightedTrustgraphsFactoryAbi,
  weightedPriorParamsControllerAbi,
  weightedTrustgraphsFactoryAbi,
} from '../abis/weightedPrior'

const MANIFEST = '0x544757500001' as Hex
const ZERO32 = `0x${'0'.repeat(64)}` as Hex
const requested = {
  name: 'Weighted',
  metadataURI: '',
  params: {
    version: 1,
    dampingFp: 850000000000000000n,
    toleranceFp: 0n,
    maxIterations: 40,
    minWeight: 0n,
    maxWeight: 100n,
    priorRoot: ZERO32,
    priorCount: 0,
    manifestSha256: ZERO32,
    schemaUid: ZERO32,
    weightFieldIndex: 1,
    accumulator: zeroAddress,
    chainId: 0n,
  },
  manifest: MANIFEST,
  metadataDigest: ZERO32,
  admin: zeroAddress,
  epochLength: 1n,
  withDistributor: false,
  distributorToken: zeroAddress,
  salt: ZERO32,
} as const

test('recovers a manifest from direct weighted creation calldata', () => {
  const data = encodeFunctionData({
    abi: weightedTrustgraphsFactoryAbi,
    functionName: 'createInstance',
    args: [requested],
  })
  assert.equal(weightedManifestFromCalldata(data, 'create'), MANIFEST)
})

test('recovers a manifest from governed weighted creation calldata', () => {
  const data = encodeFunctionData({
    abi: governedWeightedTrustgraphsFactoryAbi,
    functionName: 'createGovernedInstance',
    args: [
      requested,
      { minPaidIntervalBlocks: 1n, maxPerRootUsd: 25n * 10n ** 8n },
      { enabled: false, topN: 0, minThreshold: 0, targetThresholdBps: 0 },
    ],
  })
  assert.equal(data.slice(0, 10), '0x19000afc')
  assert.equal(weightedManifestFromCalldata(data, 'create'), MANIFEST)
})

test('recovers a manifest from prior proposal calldata', () => {
  const data = encodeFunctionData({
    abi: weightedPriorParamsControllerAbi,
    functionName: 'proposePrior',
    args: [MANIFEST, ZERO32],
  })
  assert.equal(weightedManifestFromCalldata(data, 'propose'), MANIFEST)
})
