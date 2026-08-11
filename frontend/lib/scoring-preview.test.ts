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
  trustMultiplierFp: 2n * S,
  trustShareFp: (15n * S) / 100n,
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
  signerSelection: { topN: 3, minThreshold: 1, targetThresholdBps: 5_000 },
})
assert.equal(
  same.currentRoot,
  '0x0eda9f4e92cd62624c67b676144f51a75fa8269fbc333129ee014a6e7b448d27'
)
assert.equal(same.currentRoot, same.proposedRoot)
assert.equal(same.gained, 0)
assert.equal(same.lost, 0)
assert.equal(same.unchanged, 3)
assert.equal(same.signerChange?.changed, false)

const proposed = { ...params, trustMultiplierFp: 3n * S }
const changed = previewScoringChange({ edges, current: params, proposed })
assert.notEqual(changed.currentRoot, changed.proposedRoot)
assert.equal(changed.gained + changed.lost + changed.unchanged, 3)
assert.equal(changed.inputAcc, same.inputAcc)
assert.equal(changed.inputCount, 3n)

console.log('scoring preview golden parity and comparison: ok')
