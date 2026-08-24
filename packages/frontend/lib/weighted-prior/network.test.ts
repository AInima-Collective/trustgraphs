import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import type { Hex } from 'viem'

import { trustgraphsTabs } from '../network-nav'
import type { WeightedApiInstanceDetail } from './api'
import { weightedInstanceToNetwork } from './network'

const hex = (digit: string, bytes: number) =>
  `0x${digit.repeat(bytes * 2)}` as Hex

const instance: WeightedApiInstanceDetail = {
  id: hex('1', 32),
  program: 'trust-graph-weighted',
  chainId: '31337',
  factory: hex('2', 20),
  controller: hex('3', 20),
  creator: hex('4', 20),
  admin: hex('5', 20),
  name: 'Weighted test',
  metadataURI: '',
  resolver: hex('6', 20),
  schemaUid: hex('7', 32),
  snapshot: hex('8', 20),
  distributor: null,
  distributorToken: null,
  governance: {
    module: hex('f', 20),
    safe: hex('0', 20),
  },
  epochLength: '1',
  currentVersion: '1',
  currentParamsHash: hex('9', 32),
  params: {
    version: 1,
    dampingFp: '850000000000000000',
    toleranceFp: '0',
    maxIterations: 40,
    minWeight: '0',
    maxWeight: '100',
    priorRoot: hex('a', 32),
    priorCount: 1,
    manifestSha256: hex('b', 32),
    schemaUid: hex('7', 32),
    weightFieldIndex: 1,
    accumulator: hex('6', 20),
    chainId: '31337',
  },
  metadataDigest: hex('c', 32),
  createdBlock: '10',
  createdTimestamp: '20',
  createdTxHash: hex('d', 32),
}

const account = hex('e', 20)
const network = weightedInstanceToNetwork(instance, [
  { position: 0, account, normalizedWeight: '1000000000000000000' },
])

assert.equal(network.program, 'trust-graph-weighted')
assert.equal(network.id, instance.id)
assert.equal(network.contracts.merkleSnapshot, instance.snapshot)
assert.equal(network.contracts.merkleGovModule, instance.governance?.module)
assert.equal(network.contracts.safe?.proxy, instance.governance?.safe)
assert.equal(network.schemas[0]?.uid, instance.schemaUid)
assert.deepEqual(network.pagerank.trustedSeeds, [account])
assert.equal(network.safeZodiacSignerSync.enabled, false)
network.contracts.merkleFundDistributor = hex('2', 20)
assert.deepEqual(
  trustgraphsTabs(network).map((tab) => tab.label),
  ['Overview', 'Governance', 'Rewards', 'Settings']
)

const catalogServer = readFileSync('lib/catalog.server.ts', 'utf8')
assert.match(catalogServer, /getWeightedNetwork/)
assert.match(catalogServer, /every network sub-route/)

const settings = readFileSync(
  'app/networks/[id]/settings/component.tsx',
  'utf8'
)
assert.match(settings, /WEIGHTED_TRUSTGRAPH_PROGRAM/)
assert.match(settings, /Review starting shares/)
assert.match(settings, /Weighted networks cannot start/)

console.log('weighted network overview adapter tests passed')
