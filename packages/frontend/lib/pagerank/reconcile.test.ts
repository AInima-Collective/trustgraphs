import assert from 'node:assert/strict'

import { type Hex, concat } from 'viem'

import { buildGraph, graphIsEmpty } from './reconcile'
import { type Params, type RawEdge } from './types'
import { wordU256 } from './words'

const S = 10n ** 18n
const addr = (b: number): Hex =>
  `0x${b.toString(16).padStart(2, '0').repeat(20)}` as Hex
const uid = (b: number): Hex =>
  `0x${b.toString(16).padStart(2, '0').repeat(32)}` as Hex
const data = (weight: bigint): Hex => concat([wordU256(0n), wordU256(weight)])

const params: Params = {
  dampingFp: (85n * S) / 100n,
  toleranceFp: S / 1_000_000n,
  maxIterations: 100,
  minWeightFp: 0n,
  maxWeightFp: 100n * S,
  trustShareFp: S,
  trustDecayFp: (80n * S) / 100n,
  trustedSeeds: [addr(1)],
  totalPool: 10n ** 24n,
  precisionScale: S,
  schemaUid: uid(0xab),
  weightFieldIndex: 1,
  accumulator: addr(0xac),
  chainId: 31337n,
}

const edge = (
  kind: number,
  u: number,
  timestamp: bigint,
  weight: bigint
): RawEdge => ({
  kind,
  attester: addr(1),
  recipient: addr(2),
  uid: uid(u),
  blockTimestamp: timestamp,
  data: data(weight),
})

{
  const graph = buildGraph(
    [edge(0, 1, 100n, 100n), edge(0, 2, 200n, 20n), edge(1, 2, 300n, 20n)],
    params
  )
  assert.equal(
    graphIsEmpty(graph),
    true,
    'revoking the current vouch must not resurrect an older vouch for the pair'
  )
}

{
  const graph = buildGraph(
    [edge(0, 1, 100n, 100n), edge(0, 2, 200n, 20n), edge(1, 1, 300n, 100n)],
    params
  )
  assert.equal(
    graph.outgoing.get(addr(1))?.get(addr(2)),
    20n * S,
    'revoking a superseded UID must not clear the current vouch'
  )
}

{
  const graph = buildGraph(
    [edge(0, 1, 100n, 100n), edge(1, 1, 200n, 100n), edge(0, 2, 300n, 30n)],
    params
  )
  assert.equal(
    graph.outgoing.get(addr(1))?.get(addr(2)),
    30n * S,
    'a later attestation must reactivate a cleared pair'
  )
}

console.log('pagerank reconciliation tests: ok')
