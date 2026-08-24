import assert from 'node:assert/strict'
import test from 'node:test'

import { type Address, type Hex, encodeFunctionData, zeroAddress } from 'viem'

import { compositionPolicyFromCalldata } from './composition-calldata'
import {
  governedTrustComposeFactoryAbi,
  trustComposeFactoryAbi,
  trustComposeParamsControllerAbi,
} from '../abis/composition'

const ZERO32 = `0x${'0'.repeat(64)}` as Hex
const MANIFEST = '0x544743500001' as Hex
const ADAPTERS = [
  '0x0000000000000000000000000000000000000001',
  '0x0000000000000000000000000000000000000002',
] as const satisfies readonly Address[]
const requested = {
  name: 'Composed network',
  metadataURI: '',
  params: {
    version: 1,
    programId: ZERO32,
    scopeHash: ZERO32,
    identityDomain: ZERO32,
    outputKind: ZERO32,
    outputDomain: ZERO32,
    admittedProgramId: ZERO32,
    weightScale: 10n ** 18n,
    outputPool: 10n ** 24n,
    sourcePolicyRoot: ZERO32,
    sourceCount: 0,
    policyManifestSha256: ZERO32,
    maxSources: 8,
    maxEntriesPerSource: 4_096,
    maxAggregateEntries: 8_192,
    maxUnionAccounts: 8_192,
    maxAggregateBlobBytes: 1_048_576,
    maxSourceAgeBlocks: 500_000n,
    accumulator: zeroAddress,
    chainId: 0n,
  },
  policyManifest: MANIFEST,
  sourceAdapters: ADAPTERS,
  metadataDigest: ZERO32,
  admin: zeroAddress,
  epochLength: 1n,
  withDistributor: false,
  distributorToken: zeroAddress,
  salt: ZERO32,
} as const

test('recovers composition policy from direct creation calldata', () => {
  const data = encodeFunctionData({
    abi: trustComposeFactoryAbi,
    functionName: 'createInstance',
    args: [requested],
  })
  assert.deepEqual(compositionPolicyFromCalldata(data, 'create'), {
    manifest: MANIFEST,
    adapters: ADAPTERS,
  })
})

test('recovers composition policy from governed creation calldata', () => {
  const data = encodeFunctionData({
    abi: governedTrustComposeFactoryAbi,
    functionName: 'createGovernedInstance',
    args: [
      requested,
      { minPaidIntervalBlocks: 1n, maxPerRootUsd: 25n * 10n ** 8n },
      { enabled: false, topN: 0, minThreshold: 0, targetThresholdBps: 0 },
    ],
  })
  assert.deepEqual(compositionPolicyFromCalldata(data, 'create'), {
    manifest: MANIFEST,
    adapters: ADAPTERS,
  })
})

test('recovers composition policy from rotation calldata', () => {
  const data = encodeFunctionData({
    abi: trustComposeParamsControllerAbi,
    functionName: 'proposePolicy',
    args: [MANIFEST, ADAPTERS, ZERO32],
  })
  assert.deepEqual(compositionPolicyFromCalldata(data, 'propose'), {
    manifest: MANIFEST,
    adapters: ADAPTERS,
  })
})
