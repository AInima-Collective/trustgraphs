import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type FoldedVouch,
  type TimedVouch,
  currentTimedVouches,
  currentVouches,
} from './trust-reconcile'

const record = (
  kind: number,
  uid: string,
  blockNumber: bigint,
  logIndex = 0
): FoldedVouch => ({
  kind,
  uid,
  blockNumber,
  logIndex,
  attester: '0x01',
  recipient: '0x02',
})

test('revoking the current vouch leaves the pair absent instead of resurrecting an older UID', () => {
  const live = currentVouches([
    record(0, '0xold', 1n),
    record(0, '0xcurrent', 2n),
    record(1, '0xcurrent', 3n),
  ])
  assert.deepEqual(live, [])
})

test('revoking a superseded UID does not clear the current vouch', () => {
  const current = record(0, '0xcurrent', 2n)
  const live = currentVouches([
    record(0, '0xold', 1n),
    current,
    record(1, '0xold', 3n),
  ])
  assert.deepEqual(live, [current])
})

test('a later attestation reactivates a cleared pair, with log index breaking block ties', () => {
  const reattest = record(0, '0xnew', 2n, 2)
  const live = currentVouches([
    reattest,
    record(1, '0xold', 2n, 1),
    record(0, '0xold', 1n),
  ])
  assert.deepEqual(live, [reattest])
})

const timed = (
  kind: number,
  uid: string,
  timestamp: bigint,
  sourceLane: 0 | 1,
  sourceOrder: bigint,
  sourceSuborder = 0
): TimedVouch => ({
  kind,
  uid,
  timestamp,
  sourceLane,
  sourceOrder,
  sourceSuborder,
  attester: '0x01',
  recipient: '0x02',
})

test('off-chain replacement and revoke do not resurrect an older on-chain pair', () => {
  const live = currentTimedVouches([
    timed(0, '0xonchain', 100n, 0, 0n),
    timed(0, '0xoffchain', 200n, 1, 0n),
    timed(1, '0xoffchain', 300n, 1, 1n, 1),
  ])
  assert.deepEqual(live, [])
})

test('off-chain follows on-chain when effective timestamps tie', () => {
  const offchain = timed(0, '0xoffchain', 100n, 1, 0n)
  assert.deepEqual(
    currentTimedVouches([offchain, timed(0, '0xonchain', 100n, 0, 99n)]),
    [offchain]
  )
})

test('an old off-chain revoke cannot clear a newer on-chain replacement', () => {
  const onchain = timed(0, '0xonchain', 200n, 0, 1n)
  assert.deepEqual(
    currentTimedVouches([
      timed(0, '0xoffchain-old', 100n, 1, 0n),
      onchain,
      timed(1, '0xoffchain-old', 300n, 1, 1n),
    ]),
    [onchain]
  )
})
