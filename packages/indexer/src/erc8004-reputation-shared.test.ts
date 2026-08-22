import assert from 'node:assert/strict'
import test from 'node:test'

import { type Hex } from 'viem'

import {
  type ReputationReplayEvent,
  attributeReviewerAt,
  erc8004FeedbackKey,
  replayReputationEvents,
} from './erc8004-reputation-shared'

const wallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex
const responder = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex
const reputationRegistry = '0x8004baa17c55a88189ae136b182e5fda19de9b63'
const firstAgent =
  'agent:eip155:10:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432:1'
const secondAgent =
  'agent:eip155:10:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432:2'

const pos = (blockNumber: bigint, logIndex: number) => ({
  blockNumber,
  transactionIndex: 0,
  logIndex,
})

test('event-block attribution follows wallet rotation, not current identity state', () => {
  const changes = [
    {
      id: 'a-on',
      agentKey: firstAgent,
      account: wallet,
      active: true,
      ...pos(5n, 0),
    },
    {
      id: 'a-off',
      agentKey: firstAgent,
      account: wallet,
      active: false,
      ...pos(8n, 1),
    },
    {
      id: 'b-on',
      agentKey: secondAgent,
      account: wallet,
      active: true,
      ...pos(8n, 2),
    },
  ]
  assert.deepEqual(attributeReviewerAt(wallet, pos(7n, 0), changes), {
    status: 'attributed',
    agentKey: firstAgent,
    candidates: [firstAgent],
    evidence: [
      {
        agentKey: firstAgent,
        relationEventId: 'a-on',
        blockNumber: '5',
        transactionIndex: 0,
        logIndex: 0,
      },
    ],
  })
  assert.equal(
    attributeReviewerAt(wallet, pos(8n, 1), changes).agentKey,
    firstAgent,
    'a relation change at the feedback position is not substituted retroactively'
  )
  assert.equal(
    attributeReviewerAt(wallet, pos(9n, 0), changes).agentKey,
    secondAgent
  )
})

test('missing and ambiguous verified-wallet relations remain explicit', () => {
  assert.equal(
    attributeReviewerAt(wallet, pos(4n, 0), []).status,
    'unattributed'
  )
  const ambiguous = attributeReviewerAt(wallet, pos(7n, 0), [
    {
      id: 'a',
      agentKey: firstAgent,
      account: wallet,
      active: true,
      ...pos(5n, 0),
    },
    {
      id: 'b',
      agentKey: secondAgent,
      account: wallet,
      active: true,
      ...pos(6n, 0),
    },
  ])
  assert.equal(ambiguous.status, 'ambiguous')
  assert.deepEqual(ambiguous.candidates, [firstAgent, secondAgent])
})

test('raw fixture replays two tag/unit policies, a response, and revocation exactly', () => {
  const events: ReputationReplayEvent[] = [
    {
      id: 'quality',
      kind: 'NewFeedback',
      agentId: 9n,
      reviewer: wallet,
      feedbackIndex: 1n,
      value: 87n,
      valueDecimals: 0,
      tag: 'quality',
      unit: 'points/100',
      ...pos(10n, 0),
    },
    {
      id: 'latency',
      kind: 'NewFeedback',
      agentId: 9n,
      reviewer: wallet,
      feedbackIndex: 2n,
      value: 560n,
      valueDecimals: 0,
      tag: 'responseTime',
      unit: 'ms',
      ...pos(11n, 0),
    },
    {
      id: 'answer',
      kind: 'ResponseAppended',
      agentId: 9n,
      reviewer: wallet,
      feedbackIndex: 1n,
      responder,
      ...pos(12n, 0),
    },
    {
      id: 'revoke',
      kind: 'FeedbackRevoked',
      agentId: 9n,
      reviewer: wallet,
      feedbackIndex: 1n,
      ...pos(13n, 0),
    },
  ]
  const replay = replayReputationEvents(
    10,
    reputationRegistry,
    [...events].reverse()
  )
  const quality = replay.get(
    erc8004FeedbackKey(10, reputationRegistry, 9n, wallet, 1n)
  )!
  const latency = replay.get(
    erc8004FeedbackKey(10, reputationRegistry, 9n, wallet, 2n)
  )!
  assert.equal(quality.revoked, true)
  assert.deepEqual(quality.responseEventIds, ['answer'])
  assert.equal(quality.value, 87n)
  assert.deepEqual([quality.tag, quality.unit], ['quality', 'points/100'])
  assert.deepEqual([latency.tag, latency.unit], ['responseTime', 'ms'])
})
