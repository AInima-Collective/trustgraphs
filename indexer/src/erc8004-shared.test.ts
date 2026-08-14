import assert from 'node:assert/strict'
import test from 'node:test'

import { type Hex, zeroAddress } from 'viem'

import {
  type Erc8004LifecycleEvent,
  decodeAgentWallet,
  erc8004AgentKey,
  replayErc8004Lifecycle,
} from './erc8004-shared'

const alice = '0x1111111111111111111111111111111111111111' as Hex
const bob = '0x2222222222222222222222222222222222222222' as Hex
const walletA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex
const walletB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex

const event = <
  T extends Omit<
    Erc8004LifecycleEvent,
    'blockNumber' | 'transactionIndex' | 'logIndex'
  >,
>(
  value: T,
  transactionIndex: number,
  logIndex: number
): Erc8004LifecycleEvent =>
  ({
    ...value,
    blockNumber: 10n,
    transactionIndex,
    logIndex,
  }) as unknown as Erc8004LifecycleEvent

/** Local lifecycle fixture: two registrations, wallet set/unset, and a transfer clear. */
const fixture: Erc8004LifecycleEvent[] = [
  event({ kind: 'Transfer', agentId: 0n, from: zeroAddress, to: alice }, 0, 0),
  event(
    { kind: 'Registered', agentId: 0n, owner: alice, uri: 'data:agent-a' },
    0,
    1
  ),
  event(
    { kind: 'MetadataSet', agentId: 0n, key: 'agentWallet', value: walletA },
    0,
    2
  ),
  event({ kind: 'Transfer', agentId: 1n, from: zeroAddress, to: alice }, 1, 0),
  event(
    { kind: 'Registered', agentId: 1n, owner: alice, uri: 'ipfs://agent-b' },
    1,
    1
  ),
  event(
    { kind: 'MetadataSet', agentId: 1n, key: 'agentWallet', value: walletB },
    1,
    2
  ),
  event(
    { kind: 'MetadataSet', agentId: 1n, key: 'agentWallet', value: '0x' },
    2,
    0
  ),
  // Reference transfer order is wallet clear before Transfer.
  event(
    { kind: 'MetadataSet', agentId: 0n, key: 'agentWallet', value: '0x' },
    3,
    0
  ),
  event({ kind: 'Transfer', agentId: 0n, from: alice, to: bob }, 3, 1),
]

test('qualified keys do not merge IDs from different registries', () => {
  assert.equal(
    erc8004AgentKey(10, '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD', 7n),
    'agent:eip155:10:0xabcdefabcdefabcdefabcdefabcdefabcdefabcd:7'
  )
})

test('packed and ABI-padded wallet bytes decode, malformed bytes do not', () => {
  assert.equal(decodeAgentWallet(walletA), walletA)
  assert.equal(
    decodeAgentWallet(`0x${'0'.repeat(24)}${walletA.slice(2)}` as Hex),
    walletA
  )
  assert.equal(decodeAgentWallet('0x1234'), null)
  assert.equal(decodeAgentWallet('0x'), null)
})

test('two-agent fixture replays in block/transaction/log order', () => {
  // Reverse input to prove the reducer is using canonical event position, not arrival order.
  const { agents, relations } = replayErc8004Lifecycle([...fixture].reverse())
  assert.deepEqual(agents.get(0n), {
    agentId: 0n,
    owner: bob,
    agentWallet: null,
    uri: 'data:agent-a',
  })
  assert.deepEqual(agents.get(1n), {
    agentId: 1n,
    owner: alice,
    agentWallet: null,
    uri: 'ipfs://agent-b',
  })
  assert.equal(
    relations.filter(
      (change) => change.relation === 'verified_wallet' && change.active
    ).length,
    2
  )
  assert.equal(
    relations.filter(
      (change) => change.relation === 'verified_wallet' && !change.active
    ).length,
    2
  )
  assert.deepEqual(
    relations
      .filter((change) => change.relation === 'owner')
      .map((change) => [change.agentId, change.account, change.active]),
    [
      [0n, alice, true],
      [1n, alice, true],
      [0n, alice, false],
      [0n, bob, true],
    ]
  )
})
