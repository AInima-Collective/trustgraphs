import { ponder } from 'ponder:registry'
import {
  erc8004Agent,
  erc8004AgentEvent,
  erc8004AgentRelationHistory,
  erc8004AgentUriVersion,
  erc8004Registry,
  erc8004RegistryEvent,
} from 'ponder:schema'
import { type Hex, zeroAddress } from 'viem'

import {
  decodeAgentWallet,
  erc8004AgentKey,
  erc8004RegistryKey,
} from './erc8004-shared'
import { erc8004IdentityRegistryAbi } from '../abis/erc8004IdentityRegistry'

const position = (event: {
  block: { number: bigint; timestamp: bigint }
  transaction: { hash: Hex; transactionIndex: number }
  log: { logIndex: number }
}) => ({
  blockNumber: event.block.number,
  transactionIndex: event.transaction.transactionIndex,
  logIndex: event.log.logIndex,
  timestamp: event.block.timestamp,
  txHash: event.transaction.hash,
})

const registryIdFor = (chainId: number, address: Hex) =>
  erc8004RegistryKey(chainId, address)
const agentIdFor = (chainId: number, address: Hex, agentId: bigint) =>
  erc8004AgentKey(chainId, address, agentId)

ponder.on('erc8004IdentityRegistry:Upgraded', async ({ event, context }) => {
  const proxy = event.log.address
  const registryId = registryIdFor(context.chain.id, proxy)
  let version = 'unknown'
  try {
    version = await context.client.readContract({
      address: proxy,
      abi: erc8004IdentityRegistryAbi,
      functionName: 'getVersion',
      blockNumber: event.block.number,
    })
  } catch (error) {
    console.warn(`erc8004: getVersion failed at ${event.id}:`, error)
  }
  await context.db
    .insert(erc8004Registry)
    .values({
      id: registryId,
      chainId: `${context.chain.id}`,
      proxy,
      implementation: event.args.implementation,
      version,
      owner: null,
      sourceBlock: event.block.number,
      observedBlock: event.block.number,
      observedTimestamp: event.block.timestamp,
      observedTxHash: event.transaction.hash,
    })
    .onConflictDoUpdate({
      implementation: event.args.implementation,
      version,
      observedBlock: event.block.number,
      observedTimestamp: event.block.timestamp,
      observedTxHash: event.transaction.hash,
    })

  await context.db.insert(erc8004RegistryEvent).values({
    id: event.id,
    registryId,
    kind: 'upgrade',
    implementation: event.args.implementation,
    version,
    previousOwner: null,
    newOwner: null,
    ...position(event),
  })
})

ponder.on(
  'erc8004IdentityRegistry:OwnershipTransferred',
  async ({ event, context }) => {
    const registryId = registryIdFor(context.chain.id, event.log.address)
    // Out-of-universe guard: the registry row is born from `Upgraded`. An ownership transfer whose
    // `Upgraded` predates the start block has no row, and the row is not reconstructible here
    // (`implementation` is notNull and not in this event) — log and skip the row update, but keep
    // the append-only receipt so the transfer is not lost.
    const registry = await context.db.find(erc8004Registry, { id: registryId })
    if (registry) {
      await context.db.update(erc8004Registry, { id: registryId }).set({
        owner: event.args.newOwner,
        observedBlock: event.block.number,
        observedTimestamp: event.block.timestamp,
        observedTxHash: event.transaction.hash,
      })
    } else {
      console.warn(
        `erc8004: ownership transfer for unobserved registry ${registryId} (Upgraded predates the start block?) — recording the event only`
      )
    }
    await context.db.insert(erc8004RegistryEvent).values({
      id: event.id,
      registryId,
      kind: 'ownership',
      implementation: null,
      version: null,
      previousOwner: event.args.previousOwner,
      newOwner: event.args.newOwner,
      ...position(event),
    })
  }
)

ponder.on('erc8004IdentityRegistry:Transfer', async ({ event, context }) => {
  const agentId = event.args.tokenId
  const agentKey = agentIdFor(context.chain.id, event.log.address, agentId)
  const existing = await context.db.find(erc8004Agent, { id: agentKey })
  const nextOwner = event.args.to === zeroAddress ? null : event.args.to
  const eventPosition = position(event)

  await context.db
    .insert(erc8004Agent)
    .values({
      id: agentKey,
      chainId: `${context.chain.id}`,
      registry: event.log.address,
      agentId,
      owner: nextOwner,
      agentWallet: null,
      agentURI: '',
      registeredBlock: event.block.number,
      registeredTimestamp: event.block.timestamp,
      registeredTxHash: event.transaction.hash,
      updatedBlock: event.block.number,
      updatedTransactionIndex: event.transaction.transactionIndex,
      updatedLogIndex: event.log.logIndex,
      updatedTimestamp: event.block.timestamp,
      updatedTxHash: event.transaction.hash,
    })
    .onConflictDoUpdate({
      owner: nextOwner,
      // A transfer clears the verified wallet in the official implementation. Clearing here too
      // prevents stale attribution if a future/non-conforming implementation omits the event.
      agentWallet:
        event.args.from === zeroAddress
          ? (existing?.agentWallet ?? null)
          : null,
      updatedBlock: event.block.number,
      updatedTransactionIndex: event.transaction.transactionIndex,
      updatedLogIndex: event.log.logIndex,
      updatedTimestamp: event.block.timestamp,
      updatedTxHash: event.transaction.hash,
    })

  if (event.args.from !== zeroAddress) {
    await context.db.insert(erc8004AgentRelationHistory).values({
      id: `${event.id}:owner:off`,
      agentKey,
      relation: 'owner',
      account: event.args.from,
      active: false,
      ...eventPosition,
    })
    if (existing?.agentWallet) {
      await context.db.insert(erc8004AgentRelationHistory).values({
        id: `${event.id}:wallet:defensive-off`,
        agentKey,
        relation: 'verified_wallet',
        account: existing.agentWallet,
        active: false,
        ...eventPosition,
      })
    }
  }
  if (event.args.to !== zeroAddress) {
    await context.db.insert(erc8004AgentRelationHistory).values({
      id: `${event.id}:owner:on`,
      agentKey,
      relation: 'owner',
      account: event.args.to,
      active: true,
      ...eventPosition,
    })
  }

  await context.db.insert(erc8004AgentEvent).values({
    id: event.id,
    agentKey,
    kind: 'Transfer',
    actor: null,
    from: event.args.from,
    to: event.args.to,
    uri: null,
    metadataKey: null,
    metadataValue: null,
    ...eventPosition,
  })
})

ponder.on('erc8004IdentityRegistry:Registered', async ({ event, context }) => {
  const agentKey = agentIdFor(
    context.chain.id,
    event.log.address,
    event.args.agentId
  )
  const eventPosition = position(event)
  await context.db
    .insert(erc8004Agent)
    .values({
      id: agentKey,
      chainId: `${context.chain.id}`,
      registry: event.log.address,
      agentId: event.args.agentId,
      owner: event.args.owner,
      agentWallet: null,
      agentURI: event.args.agentURI,
      registeredBlock: event.block.number,
      registeredTimestamp: event.block.timestamp,
      registeredTxHash: event.transaction.hash,
      updatedBlock: event.block.number,
      updatedTransactionIndex: event.transaction.transactionIndex,
      updatedLogIndex: event.log.logIndex,
      updatedTimestamp: event.block.timestamp,
      updatedTxHash: event.transaction.hash,
    })
    .onConflictDoUpdate({
      owner: event.args.owner,
      agentURI: event.args.agentURI,
      registeredBlock: event.block.number,
      registeredTimestamp: event.block.timestamp,
      registeredTxHash: event.transaction.hash,
      updatedBlock: event.block.number,
      updatedTransactionIndex: event.transaction.transactionIndex,
      updatedLogIndex: event.log.logIndex,
      updatedTimestamp: event.block.timestamp,
      updatedTxHash: event.transaction.hash,
    })

  await context.db.insert(erc8004AgentUriVersion).values({
    id: event.id,
    agentKey,
    uri: event.args.agentURI,
    kind: 'registered',
    updatedBy: event.args.owner,
    ...eventPosition,
  })
  await context.db.insert(erc8004AgentEvent).values({
    id: event.id,
    agentKey,
    kind: 'Registered',
    actor: event.args.owner,
    from: null,
    to: null,
    uri: event.args.agentURI,
    metadataKey: null,
    metadataValue: null,
    ...eventPosition,
  })
})

ponder.on('erc8004IdentityRegistry:URIUpdated', async ({ event, context }) => {
  const agentKey = agentIdFor(
    context.chain.id,
    event.log.address,
    event.args.agentId
  )
  const eventPosition = position(event)
  // Out-of-universe guard: upsert with first-observed defaults (the `Transfer` handler's precedent) so
  // a URI update for an agent registered before the start block materializes the row instead of
  // wedging. Owner/wallet stay unknown until an event that carries them arrives.
  await context.db
    .insert(erc8004Agent)
    .values({
      id: agentKey,
      chainId: `${context.chain.id}`,
      registry: event.log.address,
      agentId: event.args.agentId,
      owner: null,
      agentWallet: null,
      agentURI: event.args.newURI,
      registeredBlock: event.block.number,
      registeredTimestamp: event.block.timestamp,
      registeredTxHash: event.transaction.hash,
      updatedBlock: event.block.number,
      updatedTransactionIndex: event.transaction.transactionIndex,
      updatedLogIndex: event.log.logIndex,
      updatedTimestamp: event.block.timestamp,
      updatedTxHash: event.transaction.hash,
    })
    .onConflictDoUpdate({
      agentURI: event.args.newURI,
      updatedBlock: event.block.number,
      updatedTransactionIndex: event.transaction.transactionIndex,
      updatedLogIndex: event.log.logIndex,
      updatedTimestamp: event.block.timestamp,
      updatedTxHash: event.transaction.hash,
    })
  await context.db.insert(erc8004AgentUriVersion).values({
    id: event.id,
    agentKey,
    uri: event.args.newURI,
    kind: 'updated',
    updatedBy: event.args.updatedBy,
    ...eventPosition,
  })
  await context.db.insert(erc8004AgentEvent).values({
    id: event.id,
    agentKey,
    kind: 'URIUpdated',
    actor: event.args.updatedBy,
    from: null,
    to: null,
    uri: event.args.newURI,
    metadataKey: null,
    metadataValue: null,
    ...eventPosition,
  })
})

ponder.on('erc8004IdentityRegistry:MetadataSet', async ({ event, context }) => {
  const agentKey = agentIdFor(
    context.chain.id,
    event.log.address,
    event.args.agentId
  )
  const eventPosition = position(event)
  if (event.args.metadataKey === 'agentWallet') {
    const existing = await context.db.find(erc8004Agent, { id: agentKey })
    const nextWallet = decodeAgentWallet(event.args.metadataValue)
    if (existing?.agentWallet && existing.agentWallet !== nextWallet) {
      await context.db.insert(erc8004AgentRelationHistory).values({
        id: `${event.id}:wallet:off`,
        agentKey,
        relation: 'verified_wallet',
        account: existing.agentWallet,
        active: false,
        ...eventPosition,
      })
    }
    if (nextWallet && nextWallet !== existing?.agentWallet) {
      await context.db.insert(erc8004AgentRelationHistory).values({
        id: `${event.id}:wallet:on`,
        agentKey,
        relation: 'verified_wallet',
        account: nextWallet,
        active: true,
        ...eventPosition,
      })
    }
    // Out-of-universe guard: same first-observed upsert as `URIUpdated` above — a wallet claim for an
    // agent registered before the start block materializes the row instead of wedging.
    await context.db
      .insert(erc8004Agent)
      .values({
        id: agentKey,
        chainId: `${context.chain.id}`,
        registry: event.log.address,
        agentId: event.args.agentId,
        owner: null,
        agentWallet: nextWallet,
        agentURI: '',
        registeredBlock: event.block.number,
        registeredTimestamp: event.block.timestamp,
        registeredTxHash: event.transaction.hash,
        updatedBlock: event.block.number,
        updatedTransactionIndex: event.transaction.transactionIndex,
        updatedLogIndex: event.log.logIndex,
        updatedTimestamp: event.block.timestamp,
        updatedTxHash: event.transaction.hash,
      })
      .onConflictDoUpdate({
        agentWallet: nextWallet,
        updatedBlock: event.block.number,
        updatedTransactionIndex: event.transaction.transactionIndex,
        updatedLogIndex: event.log.logIndex,
        updatedTimestamp: event.block.timestamp,
        updatedTxHash: event.transaction.hash,
      })
  }

  await context.db.insert(erc8004AgentEvent).values({
    id: event.id,
    agentKey,
    kind: 'MetadataSet',
    actor: null,
    from: null,
    to: null,
    uri: null,
    metadataKey: event.args.metadataKey,
    metadataValue: event.args.metadataValue,
    ...eventPosition,
  })
})
