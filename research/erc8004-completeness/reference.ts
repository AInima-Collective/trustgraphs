import {
  type Address,
  type Hex,
  concatHex,
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  keccak256,
  padHex,
  toBytes,
  toHex,
} from 'viem'

export const EVENT_DOMAIN = keccak256(toBytes('TRUSTGRAPHS_ERC8004_EVENT_V1'))
export const CHECKPOINT_DOMAIN = keccak256(
  toBytes('TRUSTGRAPHS_ERC8004_CHECKPOINT_V1')
)
export const EVENT_SET_VERSION = keccak256(
  toBytes('TRUSTGRAPHS_ERC8004_EVENT_SET_V1')
)

export const EventKind = {
  IdentityStateSeed: 0,
  Registered: 1,
  URIUpdated: 2,
  MetadataSet: 3,
  Transfer: 4,
  NewFeedback: 5,
  FeedbackRevoked: 6,
  ResponseAppended: 7,
  OwnershipTransferred: 8,
  ImplementationActivated: 9,
  Upgraded: 10,
  Recovery: 11,
} as const

export type EventKindValue = (typeof EventKind)[keyof typeof EventKind]

export type CanonicalEvent = {
  chainId: bigint
  registry: Address
  blockNumber: bigint
  sequence: bigint
  implementationCodeHash: Hex
  eventSetVersion: Hex
  kind: EventKindValue
  topics: Hex[]
  data: Hex
}

export type EventVector = CanonicalEvent & {
  topicsHash: Hex
  dataHash: Hex
  preimageHash: Hex
  leaf: Hex
  headAfter: Hex
  preimageHeadAfter: Hex
}

export type Checkpoint = {
  chainId: bigint
  accumulator: Address
  identityRegistry: Address
  reputationRegistry: Address
  activationBlock: bigint
  endBlock: bigint
  endBlockHash: Hex
  count: bigint
  head: Hex
  eventSetVersion: Hex
  identityImplementationCodeHash: Hex
  reputationImplementationCodeHash: Hex
  preimageCommitment: Hex
  digest: Hex
}

export type CompletenessPolicy = {
  chainId: bigint
  accumulator: Address
  identityRegistry: Address
  reputationRegistry: Address
  activationBlock: bigint
  eventSetVersion: Hex
  approvedImplementationCodeHashes: ReadonlySet<string>
  finalizedEndBlockHash: Hex
  availableSequences?: ReadonlySet<bigint>
}

export class CompletenessError extends Error {}

const fail = (message: string): never => {
  throw new CompletenessError(message)
}

const asUintWord = (value: bigint) => toHex(value, { size: 32 })

export const topicAddress = (value: Address): Hex => padHex(value, { size: 32 })

export const addressFromTopic = (value: Hex): Address =>
  getAddress(`0x${value.slice(-40)}`).toLowerCase() as Address

export const uintFromTopic = (value: Hex): bigint => BigInt(value)

/**
 * Frozen topic-vector preimage: one byte of topic count followed by the 32-byte topics in order.
 * The count makes the empty vector and any future variable-length vector unambiguous.
 */
export const topicsHash = (topics: Hex[]): Hex => {
  if (topics.length > 4) fail('an EVM log cannot have more than four topics')
  for (const topic of topics) {
    if (topic.length !== 66) fail('every topic must be exactly 32 bytes')
  }
  return keccak256(
    concatHex([toHex(topics.length, { size: 1 }), ...topics] as Hex[])
  )
}

/**
 * Frozen source-preimage commitment: topic-count || topics || uint64(data.length) || data.
 * It is folded separately so an exporter can prove it possesses every raw log preimage, not only
 * the leaf hashes recorded by the cooperating accumulator.
 */
export const preimageHash = (topics: Hex[], data: Hex): Hex => {
  const dataBytes = BigInt((data.length - 2) / 2)
  return keccak256(
    concatHex([
      toHex(topics.length, { size: 1 }),
      ...topics,
      toHex(dataBytes, { size: 8 }),
      data,
    ] as Hex[])
  )
}

export const fold = (previous: Hex, leaf: Hex): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }],
      [previous, leaf]
    )
  )

/**
 * Static ABI event leaf shared by the cooperating mirror, future guest/prover, and verifier.
 * Dynamic source fields never undergo text normalization: their exact EVM topic/data bytes are
 * committed by topicsHash/dataHash.
 */
export const eventLeaf = (event: CanonicalEvent): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint8' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        EVENT_DOMAIN,
        event.chainId,
        event.registry,
        event.blockNumber,
        event.sequence,
        event.implementationCodeHash,
        event.eventSetVersion,
        event.kind,
        topicsHash(event.topics),
        keccak256(event.data),
      ]
    )
  )

export const buildVectors = (events: CanonicalEvent[]): EventVector[] => {
  let head: Hex = toHex(0n, { size: 32 })
  let preimages: Hex = toHex(0n, { size: 32 })
  return events.map((event) => {
    const leaf = eventLeaf(event)
    const sourcePreimage = preimageHash(event.topics, event.data)
    head = fold(head, leaf)
    preimages = fold(preimages, sourcePreimage)
    return {
      ...event,
      topicsHash: topicsHash(event.topics),
      dataHash: keccak256(event.data),
      preimageHash: sourcePreimage,
      leaf,
      headAfter: head,
      preimageHeadAfter: preimages,
    }
  })
}

export const checkpointDigest = (checkpoint: Omit<Checkpoint, 'digest'>): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'bytes32' },
        { type: 'uint64' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        CHECKPOINT_DOMAIN,
        checkpoint.chainId,
        checkpoint.accumulator,
        checkpoint.identityRegistry,
        checkpoint.reputationRegistry,
        checkpoint.activationBlock,
        checkpoint.endBlock,
        checkpoint.endBlockHash,
        checkpoint.count,
        checkpoint.head,
        checkpoint.eventSetVersion,
        checkpoint.identityImplementationCodeHash,
        checkpoint.reputationImplementationCodeHash,
        checkpoint.preimageCommitment,
      ]
    )
  )

export const makeCheckpoint = (
  events: CanonicalEvent[],
  input: Omit<Checkpoint, 'count' | 'head' | 'preimageCommitment' | 'digest'>
): Checkpoint => {
  const vectors = buildVectors(events)
  const last = vectors.at(-1)
  const withoutDigest = {
    ...input,
    count: BigInt(vectors.length),
    head: last?.headAfter ?? toHex(0n, { size: 32 }),
    preimageCommitment: last?.preimageHeadAfter ?? toHex(0n, { size: 32 }),
  }
  return { ...withoutDigest, digest: checkpointDigest(withoutDigest) }
}

const sameAddress = (left: Address, right: Address) =>
  left.toLowerCase() === right.toLowerCase()

const codeHashKey = (value: Hex) => value.toLowerCase()

/**
 * Guest-shaped verifier for the miniature. It deliberately consumes the supplied order instead of
 * sorting: deletion, insertion, reorder, duplication, and range truncation must all fail against
 * the frozen checkpoint.
 */
export const verifyTrace = (
  events: CanonicalEvent[],
  checkpoint: Checkpoint,
  policy: CompletenessPolicy
) => {
  if (checkpoint.digest !== checkpointDigest(checkpoint))
    fail('checkpoint digest mismatch')
  if (checkpoint.chainId !== policy.chainId) fail('checkpoint chain mismatch')
  if (!sameAddress(checkpoint.accumulator, policy.accumulator))
    fail('checkpoint accumulator mismatch')
  if (!sameAddress(checkpoint.identityRegistry, policy.identityRegistry))
    fail('checkpoint identity registry mismatch')
  if (!sameAddress(checkpoint.reputationRegistry, policy.reputationRegistry))
    fail('checkpoint reputation registry mismatch')
  if (checkpoint.activationBlock !== policy.activationBlock)
    fail('checkpoint activation block mismatch')
  if (checkpoint.eventSetVersion !== policy.eventSetVersion)
    fail('checkpoint event-set version mismatch')
  if (checkpoint.endBlockHash !== policy.finalizedEndBlockHash)
    fail('checkpoint is not on the finalized source fork')
  if (checkpoint.count !== BigInt(events.length))
    fail('checkpoint event count mismatch')

  const current = new Map<string, Hex>()
  const approved = policy.approvedImplementationCodeHashes
  for (const [index, event] of events.entries()) {
    if (event.sequence !== BigInt(index))
      fail(`non-contiguous sequence at ${index}`)
    if (event.chainId !== policy.chainId) fail(`event ${index} chain mismatch`)
    if (
      !sameAddress(event.registry, policy.identityRegistry) &&
      !sameAddress(event.registry, policy.reputationRegistry)
    )
      fail(`event ${index} registry is outside the admitted pair`)
    if (
      event.blockNumber < policy.activationBlock ||
      event.blockNumber > checkpoint.endBlock
    )
      fail(`event ${index} is outside the checkpoint range`)
    if (event.eventSetVersion !== policy.eventSetVersion)
      fail(`event ${index} event-set version mismatch`)
    if (
      policy.availableSequences &&
      !policy.availableSequences.has(event.sequence)
    )
      fail(`event ${index} preimage is unavailable`)

    const registryKey = event.registry.toLowerCase()
    if (event.kind === EventKind.Recovery)
      fail(`event ${index} crosses a recovery boundary`)
    if (event.kind === EventKind.ImplementationActivated) {
      if (current.has(registryKey))
        fail(`event ${index} activates an already-active registry`)
      if (!approved.has(codeHashKey(event.implementationCodeHash)))
        fail(`event ${index} activates an unreviewed implementation`)
      current.set(registryKey, event.implementationCodeHash)
      continue
    }
    if (event.kind === EventKind.Upgraded) {
      if (!current.has(registryKey))
        fail(`event ${index} upgrades an inactive registry`)
      if (!approved.has(codeHashKey(event.implementationCodeHash)))
        fail(`event ${index} upgrades to an unreviewed implementation`)
      current.set(registryKey, event.implementationCodeHash)
      continue
    }
    const active = current.get(registryKey)
    if (!active) fail(`event ${index} precedes implementation activation`)
    if (active !== event.implementationCodeHash)
      fail(`event ${index} implementation epoch mismatch`)
  }

  const vectors = buildVectors(events)
  const last = vectors.at(-1)
  const actualHead = last?.headAfter ?? toHex(0n, { size: 32 })
  const actualPreimages = last?.preimageHeadAfter ?? toHex(0n, { size: 32 })
  if (actualHead !== checkpoint.head) fail('event accumulator mismatch')
  if (actualPreimages !== checkpoint.preimageCommitment)
    fail('source-preimage commitment mismatch')
  if (
    current.get(policy.identityRegistry.toLowerCase()) !==
    checkpoint.identityImplementationCodeHash
  )
    fail('identity implementation checkpoint mismatch')
  if (
    current.get(policy.reputationRegistry.toLowerCase()) !==
    checkpoint.reputationImplementationCodeHash
  )
    fail('reputation implementation checkpoint mismatch')
  return { head: actualHead, count: BigInt(events.length) }
}

export type FeedbackAttribution = {
  sequence: bigint
  reviewer: Address
  status: 'attributed' | 'unattributed' | 'ambiguous'
  agentIds: bigint[]
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const AGENT_WALLET_KEY_HASH = keccak256(toBytes('agentWallet'))

const decodeWallet = (value: Hex): Address | null => {
  if (value === '0x') return null
  const raw = value.slice(2)
  if (raw.length === 40) return getAddress(`0x${raw}`).toLowerCase() as Address
  if (raw.length === 64 && /^0{24}/.test(raw))
    return getAddress(`0x${raw.slice(24)}`).toLowerCase() as Address
  return fail('agentWallet metadata is not a packed or ABI-padded address')
}

/** Historical feedback attribution driven only by the same complete ordered trace. */
export const attributeFeedback = (
  events: CanonicalEvent[],
  identityRegistry: Address,
  reputationRegistry: Address
): FeedbackAttribution[] => {
  const walletByAgent = new Map<bigint, Address>()
  const updateWallet = (agentId: bigint, wallet: Address | null) => {
    if (wallet) walletByAgent.set(agentId, wallet)
    else walletByAgent.delete(agentId)
  }
  const attributions: FeedbackAttribution[] = []

  for (const event of events) {
    if (sameAddress(event.registry, identityRegistry)) {
      if (event.kind === EventKind.IdentityStateSeed) {
        const agentId = uintFromTopic(event.topics[1]!)
        const [, wallet] = decodeAbiParameters(
          [{ type: 'address' }, { type: 'address' }],
          event.data
        )
        updateWallet(agentId, wallet === ZERO_ADDRESS ? null : wallet)
      } else if (event.kind === EventKind.MetadataSet) {
        if (event.topics[2]?.toLowerCase() !== AGENT_WALLET_KEY_HASH) continue
        const agentId = uintFromTopic(event.topics[1]!)
        const [key, value] = decodeAbiParameters(
          [{ type: 'string' }, { type: 'bytes' }],
          event.data
        )
        if (key !== 'agentWallet')
          fail('indexed and unindexed metadata keys disagree')
        updateWallet(agentId, decodeWallet(value))
      } else if (event.kind === EventKind.Transfer) {
        const from = addressFromTopic(event.topics[1]!)
        if (from.toLowerCase() !== ZERO_ADDRESS) {
          const agentId = uintFromTopic(event.topics[3]!)
          updateWallet(agentId, null)
        }
      }
      continue
    }
    if (
      sameAddress(event.registry, reputationRegistry) &&
      event.kind === EventKind.NewFeedback
    ) {
      const reviewer = addressFromTopic(event.topics[2]!)
      const agentIds = [...walletByAgent.entries()]
        .filter(([, wallet]) => sameAddress(wallet, reviewer))
        .map(([agentId]) => agentId)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      attributions.push({
        sequence: event.sequence,
        reviewer,
        status:
          agentIds.length === 1
            ? 'attributed'
            : agentIds.length === 0
              ? 'unattributed'
              : 'ambiguous',
        agentIds,
      })
    }
  }
  return attributions
}

/** Convenient 32-byte topic for uint values in fixture builders. */
export const topicUint = (value: bigint): Hex => asUintWord(value)
