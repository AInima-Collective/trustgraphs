import { strict as assert } from 'node:assert'

import { type Hex, concat } from 'viem'

import type { Params, RawEdge } from './pagerank/types'
import { wordU256 } from './pagerank/words'
import { previewScoringChange } from './scoring-preview'

const S = 10n ** 18n
const addr = (n: number) =>
  `0x${n.toString(16).padStart(2, '0').repeat(20)}` as Hex
const uid = (n: number) =>
  `0x${n.toString(16).padStart(2, '0').repeat(32)}` as Hex
const edge = (
  from: number,
  to: number,
  id: number,
  time: bigint,
  confidence: bigint
): RawEdge => ({
  kind: 0,
  attester: addr(from),
  recipient: addr(to),
  uid: uid(id),
  blockTimestamp: time,
  data: concat([wordU256(0n), wordU256(confidence)]),
})

const edges = [
  edge(1, 2, 1, 100n, 50n),
  edge(2, 3, 2, 101n, 75n),
  edge(3, 1, 3, 102n, 90n),
]
const params: Params = {
  dampingFp: (85n * S) / 100n,
  toleranceFp: S / 1_000_000n,
  maxIterations: 100,
  minWeightFp: 0n,
  maxWeightFp: 100n * S,
  trustShareFp: S,
  trustDecayFp: (80n * S) / 100n,
  trustedSeeds: [addr(1), addr(3)],
  totalPool: 10n ** 24n,
  precisionScale: S,
  schemaUid: `0x${'ab'.repeat(32)}` as Hex,
  weightFieldIndex: 1,
  accumulator: `0x${'ac'.repeat(20)}` as Hex,
  chainId: 31_337n,
}

const same = previewScoringChange({
  edges,
  current: params,
  proposed: params,
  signerSelection: {
    topN: 3,
    minThreshold: 2,
    targetThresholdBps: 5_000,
    maxInactiveBlocks: 151_200n,
    minActivityWitnesses: 2,
  },
})
assert.equal(
  same.currentRoot,
  '0x28487cf1f154e4c7675af9751d2b368bd4980318e3555433eba2d69b9e92ec1f'
)
assert.equal(same.currentRoot, same.proposedRoot)
assert.equal(same.gained, 0)
assert.equal(same.lost, 0)
assert.equal(same.unchanged, 3)
assert.equal(same.signerChange?.changed, false)
assert.equal(same.graphNodes.length, 3)
assert.equal(same.graphEdges.length, 3)
assert.ok(same.graphEdges.every((edge) => edge.currentWeight > 0n))
assert.ok(
  same.graphEdges.every((edge) => edge.currentWeight === edge.proposedWeight)
)

const proposed = { ...params, trustDecayFp: (60n * S) / 100n }
const changed = previewScoringChange({ edges, current: params, proposed })
assert.notEqual(changed.currentRoot, changed.proposedRoot)
assert.equal(changed.gained + changed.lost + changed.unchanged, 3)
assert.equal(changed.inputAcc, same.inputAcc)
assert.equal(changed.inputCount, 3n)
assert.equal(changed.graphNodes.length, 3)
assert.equal(changed.graphEdges.length, 3)

console.log('scoring preview golden parity and comparison: ok')
