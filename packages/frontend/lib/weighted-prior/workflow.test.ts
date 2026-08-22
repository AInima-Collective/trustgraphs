import assert from 'node:assert/strict'

import { type Address, type Hex, decodeFunctionData } from 'viem'

import { weightedTrustgraphsFactoryAbi } from './contracts'
import {
  equalWeightCsv,
  parseWeightedSource,
  resolveWeightedSource,
} from './import'
import {
  BINARY_REDEPLOYMENT_NOTICE,
  createReview,
  replayWeightedWorkflow,
  rotationReview,
} from './workflow'

const A = '0x1111111111111111111111111111111111111111' as Address
const B = '0x2222222222222222222222222222222222222222' as Address
const C = '0x3333333333333333333333333333333333333333' as Address
const INSTANCE = `0x${'12'.repeat(32)}` as Hex
const TX = `0x${'34'.repeat(32)}` as Hex

const main = async () => {
  const artifacts = await resolveWeightedSource(
    parseWeightedSource(equalWeightCsv([A, B, C]), 'csv', 10n),
    {
      chainId: 1,
      blockNumber: 100n,
      blockHash: `0x${'56'.repeat(32)}` as Hex,
    },
    async () => null
  )
  const creation = createReview(
    {
      name: 'Explicit new instance',
      metadataURI: '',
      dampingFp: 850_000_000_000_000_000n,
      toleranceFp: 0n,
      maxIterations: 40,
      minWeight: 0n,
      maxWeight: 100n,
      admin: A,
      epochLength: 100n,
      withDistributor: false,
      distributorToken: '0x0000000000000000000000000000000000000000',
      salt: `0x${'78'.repeat(32)}` as Hex,
    },
    artifacts
  )
  const decoded = decodeFunctionData({
    abi: weightedTrustgraphsFactoryAbi,
    data: creation.calldata,
  })
  assert.equal(decoded.functionName, 'createInstance')
  assert.equal(decoded.args[0].manifest, artifacts.manifest)
  assert.equal(creation.priorRoot, artifacts.priorRoot)
  assert.equal(creation.manifestSha256, artifacts.manifestSha256)

  const available = {
    status: 'available' as const,
    provenance: 'transaction' as const,
    sourceTxHash: TX,
    error: null,
    verifiedAt: '100',
  }
  const rotation = rotationReview(
    [
      { position: 0, account: A, normalizedWeight: '750000000000000000' },
      { position: 1, account: B, normalizedWeight: '250000000000000000' },
    ],
    available,
    artifacts
  )
  assert.equal(rotation.kind, 'timelocked-prior-rotation')
  assert.deepEqual(
    rotation.diff.added.map((entry) => entry.account),
    [C]
  )
  assert.equal(rotation.diff.changed.length, 2)

  assert.throws(
    () =>
      rotationReview(
        [],
        {
          ...available,
          status: 'unavailable',
          error: 'archival transaction pruned',
        },
        artifacts
      ),
    /Rotation review is disabled/
  )

  const lifecycle = replayWeightedWorkflow([
    { kind: 'create', instanceId: INSTANCE, version: 1n },
    { kind: 'propose', instanceId: INSTANCE, version: 2n },
  ])
  assert.deepEqual(
    [...lifecycle],
    [
      [1n, 'active'],
      [2n, 'pending'],
    ]
  )
  const activated = replayWeightedWorkflow([
    { kind: 'create', instanceId: INSTANCE, version: 1n },
    { kind: 'propose', instanceId: INSTANCE, version: 2n },
    { kind: 'activate', instanceId: INSTANCE, version: 2n },
  ])
  assert.deepEqual(
    [...activated],
    [
      [1n, 'superseded'],
      [2n, 'active'],
    ]
  )
  assert.match(BINARY_REDEPLOYMENT_NOTICE, /separate weighted network/)
  assert.match(
    BINARY_REDEPLOYMENT_NOTICE,
    /old network and its history stay unchanged/
  )

  console.log(
    'weighted create, pending rotation, activation, unavailable diagnosis, and binary prefill workflow: ok'
  )
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
