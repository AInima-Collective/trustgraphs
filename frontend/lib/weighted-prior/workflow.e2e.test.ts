import assert from 'node:assert/strict'

import { type Address, type Hex, decodeFunctionData } from 'viem'

import {
  type WeightedApiVersion,
  availabilityDiagnosis,
  fetchBinaryInstances,
  fetchBinarySeeds,
  fetchWeightedEntries,
  fetchWeightedInstances,
  fetchWeightedVersions,
} from './api'
import { weightedTrustgraphsFactoryAbi } from './contracts'
import {
  equalWeightCsv,
  parseWeightedSource,
  resolveAddressOnlyWeightedSource,
} from './import'
import {
  BINARY_REDEPLOYMENT_NOTICE,
  createReview,
  replayWeightedWorkflow,
  rotationReview,
} from './workflow'

const API = 'https://indexer.test'
const A = '0x1111111111111111111111111111111111111111' as Address
const B = '0x2222222222222222222222222222222222222222' as Address
const C = '0x3333333333333333333333333333333333333333' as Address
const INSTANCE = `0x${'12'.repeat(32)}` as Hex
const BINARY_INSTANCE = `0x${'13'.repeat(32)}` as Hex
const CONTROLLER = '0x4444444444444444444444444444444444444444' as Address
const TX = `0x${'34'.repeat(32)}` as Hex
const HASH = `0x${'56'.repeat(32)}` as Hex

const version = (
  number: string,
  status: WeightedApiVersion['status']
): WeightedApiVersion => ({
  instanceId: INSTANCE,
  controller: CONTROLLER,
  version: number,
  status,
  commitments: {
    paramsHash: HASH,
    previousParamsHash: null,
    priorRoot: HASH,
    priorCount: 2,
    manifestSha256: HASH,
    manifestCid: 'baguqeera-test',
    metadataDigest: HASH,
  },
  readyAt: status === 'pending' ? '1' : null,
  availability: {
    status: 'available',
    provenance: 'transaction',
    sourceTxHash: TX,
    error: null,
    verifiedAt: '100',
  },
})

const active = version('1', 'active')
const pending = version('2', 'pending')
const calls: string[] = []
const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input)
  calls.push(url)
  if (url === `${API}/instances?limit=200&offset=0`) {
    return Response.json({
      instances: [
        {
          id: BINARY_INSTANCE,
          name: 'Binary network',
          trustedSeeds: [A, B, C],
        },
      ],
      pagination: { total: 1 },
    })
  }
  if (url === `${API}/weighted-priors?limit=200&offset=0`) {
    return Response.json({
      instances: [
        { id: INSTANCE, name: 'Weighted network', currentVersion: '1' },
      ],
      page: { total: 1 },
    })
  }
  if (url === `${API}/instances/${BINARY_INSTANCE}`) {
    return Response.json({ instance: { trustedSeeds: [C, A, B] } })
  }
  if (url === `${API}/weighted-priors/${INSTANCE}/versions?limit=200`) {
    return Response.json({ versions: [pending, active] })
  }
  if (
    url ===
    `${API}/weighted-priors/${INSTANCE}/versions/1/entries?limit=500&offset=0`
  ) {
    return Response.json({
      entries: [
        { position: 0, account: A, normalizedWeight: '750000000000000000' },
        { position: 1, account: B, normalizedWeight: '250000000000000000' },
      ],
      page: { total: 2 },
    })
  }
  return Response.json({ error: `unexpected request ${url}` }, { status: 404 })
}) as typeof fetch

const main = async () => {
  try {
    const binaryInstances = await fetchBinaryInstances(API)
    assert.deepEqual(
      binaryInstances.map(({ id, name }) => ({ id, name })),
      [{ id: BINARY_INSTANCE, name: 'Binary network' }]
    )
    const weightedInstances = await fetchWeightedInstances(API)
    assert.deepEqual(
      weightedInstances.map(({ id, name }) => ({ id, name })),
      [{ id: INSTANCE, name: 'Weighted network' }]
    )

    // Binary redeployment journey: the old instance supplies addresses only, and the output is a
    // visibly new weighted creation payload with deterministic equal weights.
    const seeds = await fetchBinarySeeds(API, BINARY_INSTANCE)
    const prefill = equalWeightCsv(seeds)
    assert.equal(prefill, `account,weight\n${A},1\n${B},1\n${C},1\n`)
    assert.match(BINARY_REDEPLOYMENT_NOTICE, /separate weighted network/)
    assert.match(
      BINARY_REDEPLOYMENT_NOTICE,
      /old network and its history stay unchanged/
    )

    const createArtifacts = await resolveAddressOnlyWeightedSource(
      parseWeightedSource(prefill, 'csv', 10n),
      { sourceUri: `${API}/instances/${BINARY_INSTANCE}` }
    )
    const create = createReview(
      {
        name: 'New weighted instance',
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
      createArtifacts
    )
    const decoded = decodeFunctionData({
      abi: weightedTrustgraphsFactoryAbi,
      data: create.calldata,
    })
    assert.equal(decoded.functionName, 'createInstance')
    assert.equal(decoded.args[0].manifest, create.manifest)
    assert.equal(create.priorRoot, createArtifacts.priorRoot)
    assert.equal(create.metadataDigest, createArtifacts.metadataDigest)

    // Rotation journey: load exact active bytes, construct the pending diff, then observe the
    // expected active/superseded transition after activation.
    const versions = await fetchWeightedVersions(API, INSTANCE)
    const loadedActive = versions.find((item) => item.status === 'active')!
    const loadedPending = versions.find((item) => item.status === 'pending')!
    const entries = await fetchWeightedEntries(
      API,
      INSTANCE,
      loadedActive.version
    )
    const rotationArtifacts = await resolveAddressOnlyWeightedSource(
      parseWeightedSource(`account,weight\n${A},1\n${C},3\n`, 'csv', 10n)
    )
    const rotation = rotationReview(
      entries,
      loadedActive.availability,
      rotationArtifacts
    )
    assert.deepEqual(
      rotation.diff.added.map((item) => item.account),
      [C]
    )
    assert.deepEqual(
      rotation.diff.removed.map((item) => item.account),
      [B]
    )
    assert.equal(rotation.diff.changed.length, 1)
    assert.equal(loadedPending.readyAt, '1')

    const lifecycle = replayWeightedWorkflow([
      { kind: 'create', instanceId: INSTANCE, version: 1n },
      { kind: 'propose', instanceId: INSTANCE, version: 2n },
      { kind: 'activate', instanceId: INSTANCE, version: 2n },
    ])
    assert.deepEqual(
      [...lifecycle],
      [
        [1n, 'superseded'],
        [2n, 'active'],
      ]
    )

    const unavailable = {
      ...loadedActive.availability,
      status: 'unavailable' as const,
      provenance: 'unavailable' as const,
      error: 'archival transaction pruned',
    }
    assert.match(
      availabilityDiagnosis(unavailable)!,
      /Rotation review is disabled/
    )
    assert.throws(
      () => rotationReview([], unavailable, rotationArtifacts),
      /Rotation review is disabled/
    )
    assert.equal(calls.length, 5)

    console.log(
      'weighted frontend E2E: create, binary prefill, pending diff, activation, and unavailable recovery: ok'
    )
  } finally {
    globalThis.fetch = originalFetch
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
