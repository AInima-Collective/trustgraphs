import assert from 'node:assert/strict'
import test from 'node:test'

import { type FoldedVouch, currentVouches } from './trust-reconcile'

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
