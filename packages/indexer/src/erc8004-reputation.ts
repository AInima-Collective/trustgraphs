import { and, eq } from 'drizzle-orm'
import { ponder } from 'ponder:registry'
import {
  erc8004AgentRelationHistory,
  erc8004Feedback,
  erc8004FeedbackEvent,
  erc8004FeedbackResponse,
  erc8004ReputationRegistry,
  erc8004ReputationRegistryEvent,
} from 'ponder:schema'
import { type Hex } from 'viem'

import {
  attributeReviewerAt,
  erc8004FeedbackKey,
  targetAgentKey,
} from './erc8004-reputation-shared'
import { erc8004RegistryKey } from './erc8004-shared'
import {
  OPTIMISM_ERC8004_REPUTATION_REGISTRY,
  erc8004ReputationRegistryAbi,
} from '../abis/erc8004ReputationRegistry'

const registryIdFor = (chainId: number, address: Hex) =>
  erc8004RegistryKey(chainId, address)

const eventPosition = (event: {
  block: { hash: Hex; number: bigint; timestamp: bigint }
  transaction: { hash: Hex; transactionIndex: number }
  log: { logIndex: number }
}) => ({
  blockNumber: event.block.number,
  transactionIndex: event.transaction.transactionIndex,
  logIndex: event.log.logIndex,
  timestamp: event.block.timestamp,
  txHash: event.transaction.hash,
  blockHash: event.block.hash,
})

const isPinnedOptimismRegistry = (chainId: number, address: Hex) =>
  chainId === OPTIMISM_ERC8004_REPUTATION_REGISTRY.chainId &&
  address.toLowerCase() ===
    OPTIMISM_ERC8004_REPUTATION_REGISTRY.proxy.toLowerCase()

ponder.on('erc8004ReputationRegistry:Upgraded', async ({ event, context }) => {
  const proxy = event.log.address
  const registryId = registryIdFor(context.chain.id, proxy)
  let version = 'unknown'
  let identityRegistry: Hex | null = null
  try {
    version = await context.client.readContract({
      address: proxy,
      abi: erc8004ReputationRegistryAbi,
      functionName: 'getVersion',
      blockNumber: event.block.number,
    })
  } catch (error) {
    console.warn(`erc8004 reputation: getVersion failed at ${event.id}:`, error)
  }
  try {
    identityRegistry = await context.client.readContract({
      address: proxy,
      abi: erc8004ReputationRegistryAbi,
      functionName: 'getIdentityRegistry',
      blockNumber: event.block.number,
    })
  } catch {
    // The official v1 bootstrap implementation did not expose this getter. The v2 upgrade does.
  }

  if (isPinnedOptimismRegistry(context.chain.id, proxy)) {
    const initial =
      event.block.number ===
      BigInt(OPTIMISM_ERC8004_REPUTATION_REGISTRY.sourceBlock)
    const expectedImplementation = initial
      ? OPTIMISM_ERC8004_REPUTATION_REGISTRY.initialImplementation
      : OPTIMISM_ERC8004_REPUTATION_REGISTRY.currentImplementation
    const expectedVersion = initial
      ? OPTIMISM_ERC8004_REPUTATION_REGISTRY.initialVersion
      : OPTIMISM_ERC8004_REPUTATION_REGISTRY.currentVersion
    if (
      event.args.implementation.toLowerCase() !==
      expectedImplementation.toLowerCase()
    ) {
      throw new Error(
        `erc8004 reputation: unreviewed Optimism implementation ${event.args.implementation} at block ${event.block.number}`
      )
    }
    if (version !== expectedVersion) {
      throw new Error(
        `erc8004 reputation: expected Optimism version ${expectedVersion}, observed ${version} at block ${event.block.number}`
      )
    }
    if (!initial && !identityRegistry) {
      throw new Error(
        `erc8004 reputation: Identity Registry binding unavailable at block ${event.block.number}`
      )
    }
    if (
      identityRegistry &&
      identityRegistry.toLowerCase() !==
        OPTIMISM_ERC8004_REPUTATION_REGISTRY.identityRegistry.toLowerCase()
    ) {
      throw new Error(
        `erc8004 reputation: Optimism proxy is bound to unexpected Identity Registry ${identityRegistry}`
      )
    }
  }

  await context.db
    .insert(erc8004ReputationRegistry)
    .values({
      id: registryId,
      chainId: `${context.chain.id}`,
      proxy,
      identityRegistry,
      implementation: event.args.implementation,
      version,
      owner: null,
      sourceBlock: event.block.number,
      observedBlock: event.block.number,
      observedTimestamp: event.block.timestamp,
      observedTxHash: event.transaction.hash,
    })
    .onConflictDoUpdate({
      ...(identityRegistry ? { identityRegistry } : {}),
      implementation: event.args.implementation,
      version,
      observedBlock: event.block.number,
      observedTimestamp: event.block.timestamp,
      observedTxHash: event.transaction.hash,
    })

  await context.db.insert(erc8004ReputationRegistryEvent).values({
    id: event.id,
    registryId,
    kind: 'upgrade',
    implementation: event.args.implementation,
    version,
    identityRegistry,
    previousOwner: null,
    newOwner: null,
    ...eventPosition(event),
  })
})

ponder.on(
  'erc8004ReputationRegistry:OwnershipTransferred',
  async ({ event, context }) => {
    const registryId = registryIdFor(context.chain.id, event.log.address)
    if (
      isPinnedOptimismRegistry(context.chain.id, event.log.address) &&
      event.args.newOwner.toLowerCase() !==
        OPTIMISM_ERC8004_REPUTATION_REGISTRY.expectedOwner.toLowerCase()
    ) {
      // M0 hazard sweep: scream, do not wedge. An owner change is a valid chain event even when it
      // is alarming; the Identity Registry handler (src/erc8004.ts) already treats the same drift
      // as a loud log, and a throw here would crash-loop the indexer forever on one log.
      console.error(
        `erc8004 reputation: Optimism owner changed to ${event.args.newOwner} at block ${event.block.number}`
      )
    }
    // M0 hazard sweep: the registry row is born from `Upgraded`; if that predates the start block
    // the row is not reconstructible here (implementation/version are notNull and not in this
    // event) — log and skip the row update, but keep the append-only receipt.
    const registry = await context.db.find(erc8004ReputationRegistry, {
      id: registryId,
    })
    if (registry) {
      await context.db
        .update(erc8004ReputationRegistry, { id: registryId })
        .set({
          owner: event.args.newOwner,
          observedBlock: event.block.number,
          observedTimestamp: event.block.timestamp,
          observedTxHash: event.transaction.hash,
        })
    } else {
      console.warn(
        `erc8004 reputation: ownership transfer for unobserved registry ${registryId} (Upgraded predates the start block?) — recording the event only`
      )
    }
    await context.db.insert(erc8004ReputationRegistryEvent).values({
      id: event.id,
      registryId,
      kind: 'ownership',
      implementation: null,
      version: null,
      identityRegistry: null,
      previousOwner: event.args.previousOwner,
      newOwner: event.args.newOwner,
      ...eventPosition(event),
    })
  }
)

ponder.on(
  'erc8004ReputationRegistry:NewFeedback',
  async ({ event, context }) => {
    const registryId = registryIdFor(context.chain.id, event.log.address)
    const registry = await context.db.find(erc8004ReputationRegistry, {
      id: registryId,
    })
    if (!registry?.identityRegistry) {
      throw new Error(
        `erc8004 reputation: missing Identity Registry binding for ${registryId}`
      )
    }
    if (
      isPinnedOptimismRegistry(context.chain.id, event.log.address) &&
      registry.identityRegistry.toLowerCase() !==
        OPTIMISM_ERC8004_REPUTATION_REGISTRY.identityRegistry.toLowerCase()
    ) {
      throw new Error(
        'erc8004 reputation: refusing feedback from a drifted registry binding'
      )
    }

    const position = eventPosition(event)
    const relationRows = await context.db.sql
      .select()
      .from(erc8004AgentRelationHistory)
      .where(
        and(
          eq(erc8004AgentRelationHistory.relation, 'verified_wallet'),
          eq(erc8004AgentRelationHistory.account, event.args.clientAddress)
        )
      )
    const relationPrefix = `agent:${erc8004RegistryKey(
      context.chain.id,
      registry.identityRegistry
    )}:`
    const attribution = attributeReviewerAt(
      event.args.clientAddress,
      position,
      relationRows
        .filter((row) => row.agentKey.startsWith(relationPrefix))
        .map((row) => ({
          id: row.id,
          agentKey: row.agentKey,
          account: row.account,
          active: row.active,
          blockNumber: row.blockNumber,
          transactionIndex: row.transactionIndex,
          logIndex: row.logIndex,
        }))
    )
    const feedbackId = erc8004FeedbackKey(
      context.chain.id,
      event.log.address,
      event.args.agentId,
      event.args.clientAddress,
      event.args.feedbackIndex
    )
    await context.db.insert(erc8004Feedback).values({
      id: feedbackId,
      chainId: `${context.chain.id}`,
      reputationRegistry: event.log.address,
      identityRegistry: registry.identityRegistry,
      targetAgentKey: targetAgentKey(
        context.chain.id,
        registry.identityRegistry,
        event.args.agentId
      ),
      agentId: event.args.agentId,
      reviewer: event.args.clientAddress,
      feedbackIndex: event.args.feedbackIndex,
      value: event.args.value,
      valueDecimals: event.args.valueDecimals,
      tag: event.args.tag1,
      unit: event.args.tag2,
      endpoint: event.args.endpoint,
      feedbackURI: event.args.feedbackURI,
      feedbackHash: event.args.feedbackHash,
      reviewerAttribution: attribution.status,
      reviewerAgentKey: attribution.agentKey,
      reviewerCandidates: attribution.candidates,
      reviewerAttributionEvidence: attribution.evidence,
      revoked: false,
      revokedBlock: null,
      revokedTransactionIndex: null,
      revokedLogIndex: null,
      revokedTimestamp: null,
      revokedTxHash: null,
      responseCount: 0,
      ...position,
    })
  }
)

ponder.on(
  'erc8004ReputationRegistry:FeedbackRevoked',
  async ({ event, context }) => {
    const feedbackId = erc8004FeedbackKey(
      context.chain.id,
      event.log.address,
      event.args.agentId,
      event.args.clientAddress,
      event.args.feedbackIndex
    )
    const position = eventPosition(event)
    const feedback = await context.db.find(erc8004Feedback, { id: feedbackId })
    if (!feedback) {
      // M0 hazard sweep: feedback that predates the start block (or a foreign registry window) is
      // out of our universe — log and skip instead of wedging the indexer on its revocation.
      console.warn(
        `erc8004 reputation: revocation references unobserved ${feedbackId} (feedback predates the start block?) — skipping`
      )
      return
    }
    await context.db.update(erc8004Feedback, { id: feedbackId }).set({
      revoked: true,
      revokedBlock: position.blockNumber,
      revokedTransactionIndex: position.transactionIndex,
      revokedLogIndex: position.logIndex,
      revokedTimestamp: position.timestamp,
      revokedTxHash: position.txHash,
    })
    await context.db.insert(erc8004FeedbackEvent).values({
      id: event.id,
      feedbackId,
      kind: 'revoked',
      actor: event.args.clientAddress,
      uri: null,
      contentHash: null,
      ...position,
    })
  }
)

ponder.on(
  'erc8004ReputationRegistry:ResponseAppended',
  async ({ event, context }) => {
    const feedbackId = erc8004FeedbackKey(
      context.chain.id,
      event.log.address,
      event.args.agentId,
      event.args.clientAddress,
      event.args.feedbackIndex
    )
    const position = eventPosition(event)
    const feedback = await context.db.find(erc8004Feedback, { id: feedbackId })
    if (!feedback) {
      // M0 hazard sweep: same out-of-universe rule as `FeedbackRevoked` above — log and skip.
      console.warn(
        `erc8004 reputation: response references unobserved ${feedbackId} (feedback predates the start block?) — skipping`
      )
      return
    }
    await context.db.update(erc8004Feedback, { id: feedbackId }).set({
      responseCount: feedback.responseCount + 1,
    })
    await context.db.insert(erc8004FeedbackResponse).values({
      id: event.id,
      feedbackId,
      responder: event.args.responder,
      responseURI: event.args.responseURI,
      responseHash: event.args.responseHash,
      ...position,
    })
    await context.db.insert(erc8004FeedbackEvent).values({
      id: event.id,
      feedbackId,
      kind: 'response',
      actor: event.args.responder,
      uri: event.args.responseURI,
      contentHash: event.args.responseHash,
      ...position,
    })
  }
)
