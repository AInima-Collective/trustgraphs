import assert from 'node:assert/strict'
import test from 'node:test'

import {
  encodeFeedbackCursor,
  parseFeedbackCursor,
  parseFeedbackQuery,
} from './erc8004-reputation-api-shared'

test('feedback cursor round-trips the complete canonical order key', () => {
  const cursor = {
    blockNumber: '147514999',
    transactionIndex: 3,
    logIndex: 17,
    id: 'feedback:eip155:10:0xabc:7:0xdef:1',
  }
  assert.deepEqual(parseFeedbackCursor(encodeFeedbackCursor(cursor)), cursor)
  assert.equal(parseFeedbackCursor('not-a-cursor'), null)
})

test('bulk feedback filters are exact, bounded, and stable', () => {
  const input = new Map([
    ['agent', 'agent:eip155:10:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432:7'],
    ['reviewer', '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['tag', 'responseTime'],
    ['unit', 'ms'],
    ['revoked', 'active'],
    ['fromBlock', '10'],
    ['toBlock', '20'],
    ['limit', '100'],
  ])
  const parsed = parseFeedbackQuery((name) => input.get(name))
  assert.equal(parsed.error, null)
  assert.equal(
    parsed.value?.reviewer,
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  )
  assert.deepEqual(
    [parsed.value?.tag, parsed.value?.unit, parsed.value?.revoked],
    ['responseTime', 'ms', 'active']
  )
  assert.equal(parsed.value?.fromBlock, 10n)
  assert.equal(parsed.value?.toBlock, 20n)
})

test('invalid address, block range, revocation, limit, and cursor fail closed', () => {
  for (const values of [
    new Map([['reviewer', 'nope']]),
    new Map([
      ['fromBlock', '20'],
      ['toBlock', '10'],
    ]),
    new Map([['revoked', 'false']]),
    new Map([['limit', '101']]),
    new Map([['cursor', 'invalid']]),
  ]) {
    assert.ok(parseFeedbackQuery((name) => values.get(name)).error)
  }
})
