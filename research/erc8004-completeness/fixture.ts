import {
  type Address,
  type Hex,
  encodeAbiParameters,
  keccak256,
  padHex,
  toBytes,
} from 'viem'

import {
  type CanonicalEvent,
  type CompletenessPolicy,
  EVENT_SET_VERSION,
  EventKind,
  attributeFeedback,
  buildVectors,
  makeCheckpoint,
  topicAddress,
  topicUint,
} from './reference'

export const CHAIN_ID = 10n
export const ACCUMULATOR =
  '0x0000000000000000000000000000000000008004' as Address
export const IDENTITY_REGISTRY =
  '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as Address
export const REPUTATION_REGISTRY =
  '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as Address
export const ACTIVATION_BLOCK = 160_000_000n

export const IDENTITY_IMPLEMENTATION =
  '0x0000000000000000000000000000000000001001' as Address
export const REPUTATION_IMPLEMENTATION_V1 =
  '0x0000000000000000000000000000000000002001' as Address
export const REPUTATION_IMPLEMENTATION_V2 =
  '0x0000000000000000000000000000000000002002' as Address
export const IDENTITY_IMPLEMENTATION_HASH = keccak256(
  toBytes('fixture:identity:v3')
)
export const REPUTATION_IMPLEMENTATION_V1_HASH = keccak256(
  toBytes('fixture:reputation:v3')
)
export const REPUTATION_IMPLEMENTATION_V2_HASH = keccak256(
  toBytes('fixture:reputation:v4')
)

export const OWNER_1 = '0x000000000000000000000000000000000000a001' as Address
export const OWNER_2 = '0x000000000000000000000000000000000000a002' as Address
export const OWNER_3 = '0x000000000000000000000000000000000000a003' as Address
export const OWNER_4 = '0x000000000000000000000000000000000000a004' as Address
export const WALLET_1 = '0x000000000000000000000000000000000000b001' as Address
export const WALLET_2 = '0x000000000000000000000000000000000000b002' as Address
export const WALLET_3 = '0x000000000000000000000000000000000000b003' as Address
export const WALLET_4 = '0x000000000000000000000000000000000000b004' as Address

const signature = (value: string) => keccak256(toBytes(value))
const sig = {
  activated: signature('ImplementationActivated(address,bytes32,bytes32)'),
  seed: signature('IdentityStateSeed(uint256,address,address)'),
  registered: signature('Registered(uint256,string,address)'),
  uriUpdated: signature('URIUpdated(uint256,string,address)'),
  metadataSet: signature('MetadataSet(uint256,string,string,bytes)'),
  transfer: signature('Transfer(address,address,uint256)'),
  feedback: signature(
    'NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)'
  ),
  revoked: signature('FeedbackRevoked(uint256,address,uint64)'),
  response: signature(
    'ResponseAppended(uint256,address,uint64,address,string,bytes32)'
  ),
  ownership: signature('OwnershipTransferred(address,address)'),
  upgraded: signature('Upgraded(address)'),
}

type EventInput = Omit<
  CanonicalEvent,
  'chainId' | 'blockNumber' | 'sequence' | 'eventSetVersion'
> & { blockOffset?: bigint }

const makeEvents = (inputs: EventInput[]): CanonicalEvent[] =>
  inputs.map(({ blockOffset = 0n, ...event }, index) => ({
    ...event,
    chainId: CHAIN_ID,
    blockNumber: ACTIVATION_BLOCK + blockOffset,
    sequence: BigInt(index),
    eventSetVersion: EVENT_SET_VERSION,
  }))

const metadata = (agentId: bigint, wallet: Address | null): EventInput => ({
  registry: IDENTITY_REGISTRY,
  implementationCodeHash: IDENTITY_IMPLEMENTATION_HASH,
  kind: EventKind.MetadataSet,
  topics: [
    sig.metadataSet,
    topicUint(agentId),
    keccak256(toBytes('agentWallet')),
  ],
  data: encodeAbiParameters(
    [{ type: 'string' }, { type: 'bytes' }],
    ['agentWallet', wallet ? wallet : '0x']
  ),
})

const feedback = (
  reviewer: Address,
  feedbackIndex: bigint,
  value: bigint,
  implementationCodeHash: Hex = REPUTATION_IMPLEMENTATION_V1_HASH
): EventInput => ({
  registry: REPUTATION_REGISTRY,
  implementationCodeHash,
  kind: EventKind.NewFeedback,
  topics: [
    sig.feedback,
    topicUint(2n),
    topicAddress(reviewer),
    keccak256(toBytes('quality')),
  ],
  data: encodeAbiParameters(
    [
      { type: 'uint64' },
      { type: 'int128' },
      { type: 'uint8' },
      { type: 'string' },
      { type: 'string' },
      { type: 'string' },
      { type: 'string' },
      { type: 'bytes32' },
    ],
    [
      feedbackIndex,
      value,
      0,
      'quality',
      'points/100',
      '',
      '',
      padHex('0x', { size: 32 }),
    ]
  ),
})

export const buildFixture = () => {
  const events = makeEvents([
    {
      registry: IDENTITY_REGISTRY,
      implementationCodeHash: IDENTITY_IMPLEMENTATION_HASH,
      kind: EventKind.ImplementationActivated,
      topics: [sig.activated, topicAddress(IDENTITY_IMPLEMENTATION)],
      data: encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }],
        [IDENTITY_IMPLEMENTATION_HASH, EVENT_SET_VERSION]
      ),
    },
    {
      registry: REPUTATION_REGISTRY,
      implementationCodeHash: REPUTATION_IMPLEMENTATION_V1_HASH,
      kind: EventKind.ImplementationActivated,
      topics: [sig.activated, topicAddress(REPUTATION_IMPLEMENTATION_V1)],
      data: encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }],
        [REPUTATION_IMPLEMENTATION_V1_HASH, EVENT_SET_VERSION]
      ),
    },
    {
      registry: IDENTITY_REGISTRY,
      implementationCodeHash: IDENTITY_IMPLEMENTATION_HASH,
      kind: EventKind.IdentityStateSeed,
      topics: [sig.seed, topicUint(1n)],
      data: encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }],
        [OWNER_1, WALLET_1]
      ),
    },
    {
      registry: IDENTITY_REGISTRY,
      implementationCodeHash: IDENTITY_IMPLEMENTATION_HASH,
      kind: EventKind.IdentityStateSeed,
      topics: [sig.seed, topicUint(2n)],
      data: encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }],
        [OWNER_2, WALLET_2]
      ),
    },
    {
      registry: IDENTITY_REGISTRY,
      implementationCodeHash: IDENTITY_IMPLEMENTATION_HASH,
      kind: EventKind.Registered,
      topics: [sig.registered, topicUint(3n), topicAddress(OWNER_3)],
      data: encodeAbiParameters([{ type: 'string' }], ['ipfs://agent-3']),
      blockOffset: 1n,
    },
    { ...metadata(3n, WALLET_3), blockOffset: 1n },
    {
      registry: IDENTITY_REGISTRY,
      implementationCodeHash: IDENTITY_IMPLEMENTATION_HASH,
      kind: EventKind.URIUpdated,
      topics: [sig.uriUpdated, topicUint(3n), topicAddress(OWNER_3)],
      data: encodeAbiParameters([{ type: 'string' }], ['ipfs://agent-3-v2']),
      blockOffset: 2n,
    },
    { ...feedback(WALLET_1, 1n, 90n), blockOffset: 3n },
    { ...metadata(1n, WALLET_4), blockOffset: 4n },
    { ...feedback(WALLET_1, 2n, 40n), blockOffset: 5n },
    { ...feedback(WALLET_4, 1n, 95n), blockOffset: 6n },
    {
      registry: REPUTATION_REGISTRY,
      implementationCodeHash: REPUTATION_IMPLEMENTATION_V1_HASH,
      kind: EventKind.ResponseAppended,
      topics: [
        sig.response,
        topicUint(2n),
        topicAddress(WALLET_4),
        topicAddress(OWNER_2),
      ],
      data: encodeAbiParameters(
        [{ type: 'uint64' }, { type: 'string' }, { type: 'bytes32' }],
        [1n, 'ipfs://response', keccak256(toBytes('response'))]
      ),
      blockOffset: 7n,
    },
    {
      registry: REPUTATION_REGISTRY,
      implementationCodeHash: REPUTATION_IMPLEMENTATION_V1_HASH,
      kind: EventKind.FeedbackRevoked,
      topics: [
        sig.revoked,
        topicUint(2n),
        topicAddress(WALLET_1),
        topicUint(1n),
      ],
      data: '0x',
      blockOffset: 8n,
    },
    { ...metadata(3n, null), blockOffset: 9n },
    {
      registry: IDENTITY_REGISTRY,
      implementationCodeHash: IDENTITY_IMPLEMENTATION_HASH,
      kind: EventKind.Transfer,
      topics: [
        sig.transfer,
        topicAddress(OWNER_3),
        topicAddress(OWNER_4),
        topicUint(3n),
      ],
      data: '0x',
      blockOffset: 9n,
    },
    {
      registry: REPUTATION_REGISTRY,
      implementationCodeHash: REPUTATION_IMPLEMENTATION_V1_HASH,
      kind: EventKind.OwnershipTransferred,
      topics: [sig.ownership, topicAddress(OWNER_1), topicAddress(OWNER_2)],
      data: '0x',
      blockOffset: 10n,
    },
    {
      registry: REPUTATION_REGISTRY,
      implementationCodeHash: REPUTATION_IMPLEMENTATION_V2_HASH,
      kind: EventKind.Upgraded,
      topics: [sig.upgraded, topicAddress(REPUTATION_IMPLEMENTATION_V2)],
      data: '0x',
      blockOffset: 11n,
    },
    {
      ...feedback(WALLET_4, 2n, 88n, REPUTATION_IMPLEMENTATION_V2_HASH),
      blockOffset: 12n,
    },
  ])
  const endBlock = ACTIVATION_BLOCK + 12n
  const endBlockHash = keccak256(toBytes('fixture:finalized:end-block'))
  const checkpoint = makeCheckpoint(events, {
    chainId: CHAIN_ID,
    accumulator: ACCUMULATOR,
    identityRegistry: IDENTITY_REGISTRY,
    reputationRegistry: REPUTATION_REGISTRY,
    activationBlock: ACTIVATION_BLOCK,
    endBlock,
    endBlockHash,
    eventSetVersion: EVENT_SET_VERSION,
    identityImplementationCodeHash: IDENTITY_IMPLEMENTATION_HASH,
    reputationImplementationCodeHash: REPUTATION_IMPLEMENTATION_V2_HASH,
  })
  const approvedImplementationCodeHashes = new Set(
    [
      IDENTITY_IMPLEMENTATION_HASH,
      REPUTATION_IMPLEMENTATION_V1_HASH,
      REPUTATION_IMPLEMENTATION_V2_HASH,
    ].map((value) => value.toLowerCase())
  )
  const policy: CompletenessPolicy = {
    chainId: CHAIN_ID,
    accumulator: ACCUMULATOR,
    identityRegistry: IDENTITY_REGISTRY,
    reputationRegistry: REPUTATION_REGISTRY,
    activationBlock: ACTIVATION_BLOCK,
    eventSetVersion: EVENT_SET_VERSION,
    approvedImplementationCodeHashes,
    finalizedEndBlockHash: endBlockHash,
    availableSequences: new Set(events.map((event) => event.sequence)),
  }
  return {
    events,
    vectors: buildVectors(events),
    checkpoint,
    policy,
    attribution: attributeFeedback(
      events,
      IDENTITY_REGISTRY,
      REPUTATION_REGISTRY
    ),
  }
}
