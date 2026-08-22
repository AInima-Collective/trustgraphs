import {
  assertNoFutureAttestations,
  domainSeparator,
  E0_ENTRY_WORK_UNITS,
  EasOffchainError,
  headDomain,
  MAX_PAYLOAD_BYTES,
  prefixHeads,
  validateSignedBundle,
  ZERO32,
  type AnchorMessage,
  type LiveNodeHead,
  type SignedAnchorBundle,
} from '@trustgraphs/eas-offchain-client'
import { getAddress } from 'viem'

import { RelayError } from './errors.ts'
import { storeWithQuorum } from './ipfs.ts'
import type {
  BlobStore,
  LaneState,
  RelayChain,
  RelayConfig,
  RelaySuccess,
} from './types.ts'

const exactResult = (live: LiveNodeHead, message: AnchorMessage): boolean =>
  live.count === message.count &&
  live.head === message.head &&
  live.dataCommitment === message.dataCommitment

const conflictDetails = (live: LiveNodeHead) => ({
  canonical: {
    count: live.count.toString(),
    head: live.head,
    dataCommitment: live.dataCommitment,
  },
})

class NodeRateLimiter {
  private readonly events = new Map<string, number[]>()

  constructor(private readonly limit: number) {}

  take(nodeId: string, now = Date.now()): void {
    const threshold = now - 60_000
    const recent = (this.events.get(nodeId) ?? []).filter(
      (time) => time > threshold
    )
    if (recent.length >= this.limit)
      throw new RelayError(
        'RATE_LIMITED',
        'node request rate exceeded',
        429,
        true,
        'retry'
      )
    recent.push(now)
    this.events.set(nodeId, recent)
  }
}

export class RelaySubmissionService {
  private readonly limiter: NodeRateLimiter
  private readonly metricState = {
    submissions: 0,
    validationFailures: 0,
    newestAnchorCount: 0n,
    storageExactSuccesses: 0,
    workCount: 0n,
    maxTotalInputs: 0n,
    relayerLagEntries: 0n,
  }

  constructor(
    private readonly config: RelayConfig,
    private readonly chain: RelayChain,
    private readonly stores: readonly BlobStore[]
  ) {
    if (
      stores.length < 2 ||
      config.storageQuorum < 2 ||
      config.storageQuorum > stores.length
    )
      throw new Error(
        'relay requires at least two stores and a reachable quorum of at least two'
      )
    if (config.maxPayloadBytes > MAX_PAYLOAD_BYTES)
      throw new Error(
        'relay payload limit cannot exceed the consensus 1 MiB bound'
      )
    this.limiter = new NodeRateLimiter(config.nodeRequestsPerMinute)
  }

  metrics() {
    return {
      chainId: this.config.chainId.toString(),
      registry: this.config.registry,
      relayerAddress: this.config.relayerAddress,
      easAddress: this.config.easAddress,
      easVersion: this.config.easVersion,
      schemaUid: this.config.schemaUid,
      submissions: this.metricState.submissions,
      validationFailures: this.metricState.validationFailures,
      newestAnchorCount: this.metricState.newestAnchorCount.toString(),
      storageExactSuccesses: this.metricState.storageExactSuccesses,
      storageTargetCount: this.stores.length,
      storageQuorumRequired: this.config.storageQuorum,
      workCount: this.metricState.workCount.toString(),
      maxTotalInputs: this.metricState.maxTotalInputs.toString(),
      relayerLagEntries: this.metricState.relayerLagEntries.toString(),
    }
  }

  private assertLane(
    bundle: SignedAnchorBundle,
    lane: LaneState,
    message: AnchorMessage
  ): void {
    if (
      BigInt(bundle.chainId) !== this.config.chainId ||
      lane.chainId !== this.config.chainId ||
      getAddress(bundle.registry) !== getAddress(this.config.registry) ||
      getAddress(lane.registry) !== getAddress(this.config.registry)
    )
      throw new RelayError(
        'CHAIN_OR_REGISTRY',
        'bundle targets another chain or registry',
        422,
        false,
        'none'
      )
    if (
      bundle.message.envelopeKind !== 0 ||
      bundle.schemaUid !== this.config.schemaUid ||
      lane.schemaUid !== this.config.schemaUid
    )
      throw new RelayError(
        'KIND_OR_SCHEMA',
        'bundle kind or schema is not allowlisted',
        422,
        false,
        'none'
      )
    if (
      getAddress(bundle.eas.address) !== getAddress(this.config.easAddress) ||
      getAddress(lane.easAddress) !== getAddress(this.config.easAddress) ||
      bundle.eas.version !== this.config.easVersion ||
      lane.easVersion !== this.config.easVersion
    )
      throw new RelayError(
        'EAS_DOMAIN',
        'bundle EAS domain is not the configured onchain domain',
        422,
        false,
        'none'
      )

    const easSeparator = domainSeparator({
      name: 'EAS Attestation',
      version: this.config.easVersion,
      chainId: this.config.chainId,
      verifyingContract: this.config.easAddress,
    })
    const headSeparator = domainSeparator(
      headDomain(this.config.chainId, this.config.registry)
    )
    if (
      lane.easDomainSeparator !== easSeparator ||
      lane.headDomainSeparator !== headSeparator
    )
      throw new RelayError(
        'DOMAIN_SEPARATOR',
        'onchain domain separator does not match configured typed data',
        503,
        false,
        'none'
      )
    if (
      lane.registeredOwner &&
      getAddress(lane.registeredOwner) !== getAddress(bundle.owner)
    )
      throw new RelayError(
        'NODE_OWNER',
        'registered node owner does not match bundle signer',
        409,
        false,
        'reload'
      )
    if (
      this.config.allowedNodeIds.size > 0 &&
      !this.config.allowedNodeIds.has(message.nodeId.toLowerCase())
    )
      throw new RelayError(
        'NODE_NOT_ALLOWED',
        'node is not in the relay allowlist',
        403,
        false,
        'none'
      )
  }

  private assertTransition(
    payloadHeads: readonly `0x${string}`[],
    live: LiveNodeHead,
    message: AnchorMessage
  ): void {
    if (exactResult(live, message)) return
    if (live.count === message.count)
      throw new RelayError(
        'SAME_COUNT_FORK',
        'another commitment already landed at this count',
        409,
        false,
        'reload',
        conflictDetails(live)
      )
    if (live.count > message.count)
      throw new RelayError(
        'STALE_HEAD',
        'canonical node history advanced past this bundle',
        409,
        false,
        'reload',
        conflictDetails(live)
      )
    const prefix =
      live.count === 0n ? ZERO32 : payloadHeads[Number(live.count) - 1]
    if (message.previousHead !== live.head || prefix !== live.head)
      throw new RelayError(
        'PREVIOUS_HEAD',
        'bundle does not extend the canonical live head',
        409,
        false,
        'reload',
        conflictDetails(live)
      )
  }

  private success(
    bundle: SignedAnchorBundle,
    message: AnchorMessage
  ): RelaySuccess {
    return {
      status: 'anchored',
      chainId: bundle.chainId,
      registry: bundle.registry,
      nodeId: message.nodeId,
      count: message.count.toString(),
      head: message.head,
      dataCommitment: message.dataCommitment,
      cid: bundle.cid,
    }
  }

  async submit(bundle: SignedAnchorBundle): Promise<RelaySuccess> {
    this.metricState.submissions += 1
    let validated: Awaited<ReturnType<typeof validateSignedBundle>>
    try {
      validated = await validateSignedBundle(bundle)
    } catch (error) {
      this.metricState.validationFailures += 1
      if (error instanceof EasOffchainError) throw error
      throw new RelayError(
        'INVALID_BUNDLE',
        'bundle shape or scalar encoding is invalid',
        422,
        false,
        'none'
      )
    }
    if (validated.bytes.length > this.config.maxPayloadBytes)
      throw new RelayError(
        'PAYLOAD_LIMIT',
        'payload exceeds relay limit',
        413,
        false,
        'none'
      )
    this.limiter.take(validated.message.nodeId.toLowerCase())
    const lane = await this.chain.lane(validated.message.nodeId)
    this.metricState.newestAnchorCount = lane.anchorCount
    this.metricState.workCount = lane.workCount
    this.metricState.maxTotalInputs = lane.maxTotalInputs
    this.metricState.relayerLagEntries =
      validated.message.count > lane.live.count
        ? validated.message.count - lane.live.count
        : 0n
    this.assertLane(bundle, lane, validated.message)
    assertNoFutureAttestations(validated.payload, lane.latestBlockTimestamp)
    const heads = prefixHeads(validated.payload)
    this.assertTransition(heads, lane.live, validated.message)

    if (!exactResult(lane.live, validated.message)) {
      const delta = validated.message.count - lane.live.count
      const projectedWork = lane.workCount + 1n + delta * E0_ENTRY_WORK_UNITS
      if (lane.lane1LeafCount + projectedWork > lane.maxTotalInputs)
        throw new RelayError(
          'PROJECTED_WORK',
          'anchor would exceed the instance input capacity',
          422,
          false,
          'none',
          {
            lane1LeafCount: lane.lane1LeafCount.toString(),
            projectedLane2Work: projectedWork.toString(),
            maxTotalInputs: lane.maxTotalInputs.toString(),
          }
        )
    }

    const stored = await storeWithQuorum(
      this.stores,
      this.config.storageQuorum,
      bundle.cid,
      validated.bytes
    )
    this.metricState.storageExactSuccesses = stored.length

    if (exactResult(lane.live, validated.message)) {
      this.metricState.relayerLagEntries = 0n
      return this.success(bundle, validated.message)
    }

    try {
      await this.chain.simulate(bundle, validated.message)
      await this.chain.anchor(bundle, validated.message)
    } catch (cause) {
      const racedLive = await this.chain.live(validated.message.nodeId)
      if (exactResult(racedLive, validated.message)) {
        this.metricState.newestAnchorCount = lane.anchorCount + 1n
        this.metricState.relayerLagEntries = 0n
        return this.success(bundle, validated.message)
      }
      if (racedLive.count === validated.message.count)
        throw new RelayError(
          'SAME_COUNT_FORK',
          'another commitment won the same-count race',
          409,
          false,
          'reload',
          conflictDetails(racedLive)
        )
      throw new RelayError(
        'ANCHOR_FAILED',
        'exact anchor simulation or transaction failed',
        503,
        true,
        'retry',
        {
          cause: cause instanceof RelayError ? cause.code : 'CHAIN_ERROR',
        }
      )
    }

    const landed = await this.chain.live(validated.message.nodeId)
    if (!exactResult(landed, validated.message))
      throw new RelayError(
        'ANCHOR_UNCONFIRMED',
        'transaction completed without the exact requested state',
        503,
        true,
        'retry'
      )
    this.metricState.newestAnchorCount = lane.anchorCount + 1n
    this.metricState.relayerLagEntries = 0n
    return this.success(bundle, validated.message)
  }
}
