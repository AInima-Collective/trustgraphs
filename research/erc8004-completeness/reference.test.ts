import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { keccak256, toBytes } from 'viem'

import {
  REPUTATION_IMPLEMENTATION_V2_HASH,
  WALLET_1,
  WALLET_4,
  buildFixture,
} from './fixture'
import { buildGolden } from './golden'
import {
  type CanonicalEvent,
  type Checkpoint,
  CompletenessError,
  type CompletenessPolicy,
  EventKind,
  makeCheckpoint,
  verifyTrace,
} from './reference'

const expectFailure = (
  events: CanonicalEvent[],
  checkpoint: Checkpoint,
  policy: CompletenessPolicy,
  pattern: RegExp
) => {
  assert.throws(
    () => verifyTrace(events, checkpoint, policy),
    (error: unknown) =>
      error instanceof CompletenessError && pattern.test(error.message)
  )
}

test('the canonical activation-to-checkpoint trace verifies', () => {
  const fixture = buildFixture()
  assert.deepEqual(
    verifyTrace(fixture.events, fixture.checkpoint, fixture.policy),
    {
      head: fixture.checkpoint.head,
      count: BigInt(fixture.events.length),
    }
  )
})

test('the checked-in cross-language golden is current', () => {
  const path = fileURLToPath(new URL('./golden.json', import.meta.url))
  assert.equal(readFileSync(path, 'utf8'), buildGolden())
})

test('deletion, insertion, reorder, duplication, and range truncation fail', () => {
  const fixture = buildFixture()
  const deleted = fixture.events.filter((event) => event.sequence !== 7n)
  expectFailure(deleted, fixture.checkpoint, fixture.policy, /event count/)

  const inserted = [
    ...fixture.events,
    { ...fixture.events.at(-1)!, sequence: BigInt(fixture.events.length) },
  ]
  expectFailure(inserted, fixture.checkpoint, fixture.policy, /event count/)

  const reordered = [...fixture.events]
  ;[reordered[7], reordered[8]] = [reordered[8]!, reordered[7]!]
  expectFailure(reordered, fixture.checkpoint, fixture.policy, /non-contiguous/)

  const duplicated = [...fixture.events]
  duplicated[8] = { ...duplicated[7]!, sequence: 8n }
  expectFailure(duplicated, fixture.checkpoint, fixture.policy, /accumulator/)

  const truncatedCheckpoint = makeCheckpoint(fixture.events.slice(0, -1), {
    chainId: fixture.checkpoint.chainId,
    accumulator: fixture.checkpoint.accumulator,
    identityRegistry: fixture.checkpoint.identityRegistry,
    reputationRegistry: fixture.checkpoint.reputationRegistry,
    activationBlock: fixture.checkpoint.activationBlock,
    endBlock: fixture.checkpoint.endBlock,
    endBlockHash: fixture.checkpoint.endBlockHash,
    eventSetVersion: fixture.checkpoint.eventSetVersion,
    identityImplementationCodeHash:
      fixture.checkpoint.identityImplementationCodeHash,
    reputationImplementationCodeHash:
      fixture.checkpoint.reputationImplementationCodeHash,
  })
  expectFailure(
    fixture.events,
    truncatedCheckpoint,
    fixture.policy,
    /event count/
  )
})

test('a reorged end block and unavailable preimage fail closed', () => {
  const fixture = buildFixture()
  const reorgPolicy = {
    ...fixture.policy,
    finalizedEndBlockHash: keccak256(toBytes('a different finalized fork')),
  }
  expectFailure(
    fixture.events,
    fixture.checkpoint,
    reorgPolicy,
    /finalized source fork/
  )

  const available = new Set(fixture.events.map((event) => event.sequence))
  available.delete(11n)
  expectFailure(
    fixture.events,
    fixture.checkpoint,
    { ...fixture.policy, availableSequences: available },
    /preimage is unavailable/
  )
})

test('an unreviewed implementation upgrade and recovery boundary fail closed', () => {
  const fixture = buildFixture()
  const unreviewed = keccak256(toBytes('unreviewed implementation'))
  const upgraded = fixture.events.map((event) =>
    event.kind === EventKind.Upgraded
      ? { ...event, implementationCodeHash: unreviewed }
      : event
  )
  expectFailure(upgraded, fixture.checkpoint, fixture.policy, /unreviewed/)

  const recovery = fixture.events.map((event) =>
    event.sequence === 10n ? { ...event, kind: EventKind.Recovery } : event
  )
  expectFailure(
    recovery,
    fixture.checkpoint,
    fixture.policy,
    /recovery boundary/
  )

  assert.notEqual(unreviewed, REPUTATION_IMPLEMENTATION_V2_HASH)
})

test('wallet attribution uses the same complete ordered history as feedback', () => {
  const { attribution } = buildFixture()
  assert.deepEqual(
    attribution.map(({ sequence, reviewer, status, agentIds }) => ({
      sequence,
      reviewer,
      status,
      agentIds,
    })),
    [
      {
        sequence: 7n,
        reviewer: WALLET_1,
        status: 'attributed',
        agentIds: [1n],
      },
      {
        sequence: 9n,
        reviewer: WALLET_1,
        status: 'unattributed',
        agentIds: [],
      },
      {
        sequence: 10n,
        reviewer: WALLET_4,
        status: 'attributed',
        agentIds: [1n],
      },
      {
        sequence: 17n,
        reviewer: WALLET_4,
        status: 'attributed',
        agentIds: [1n],
      },
    ]
  )
})
