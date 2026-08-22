import {
  type CanonicalAttestation,
  EasOffchainError,
  MAX_PAYLOAD_BYTES,
  type SignedAnchorBundle,
  ZERO32,
  bytesToHex,
  payloadCommitment,
  prefixHeads,
  rawCid,
  validateSignedBundle,
} from '@trustgraphs/eas-offchain-client'
import { and, asc, eq } from 'drizzle-orm'
import { ponder } from 'ponder:registry'
import {
  easOffchainAnchor,
  easOffchainLane,
  easOffchainMutation,
  easOffchainNode,
  easOffchainRegistration,
} from 'ponder:schema'
import { type Hex, getAddress } from 'viem'

const gateways = () =>
  (process.env.EAS_OFFCHAIN_GATEWAYS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

type FetchResult = {
  payloadHex: Hex
  bytes: number
  gatewayIndex: number
  latencyMs: number
}

type CommitAnchor = {
  id: string
  count: bigint
  foldIndex: bigint
  blockTimestamp: bigint
  txHash: Hex
  blockNumber: bigint
}

const fetchCanonicalPayload = async (commitment: Hex): Promise<FetchResult> => {
  const cid = rawCid(commitment)
  const started = Date.now()
  for (const [gatewayIndex, gateway] of gateways().entries()) {
    try {
      const response = await fetch(
        `${gateway}${cid}`.replace('localhost', '127.0.0.1'),
        {
          signal: AbortSignal.timeout(20_000),
        }
      )
      if (!response.ok) continue
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > MAX_PAYLOAD_BYTES) continue
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.length > MAX_PAYLOAD_BYTES) continue
      if (payloadCommitment(bytes).toLowerCase() !== commitment.toLowerCase())
        continue
      return {
        payloadHex: bytesToHex(bytes),
        bytes: bytes.length,
        gatewayIndex,
        latencyMs: Date.now() - started,
      }
    } catch {
      // Availability sources are independent and non-authoritative; try the next reader.
    }
  }
  throw new Error(gateways().length === 0 ? 'E0_NO_GATEWAY' : 'E0_UNAVAILABLE')
}

const errorCode = (error: unknown): string => {
  if (error instanceof EasOffchainError) return error.code
  if (error instanceof Error && /^E0_[A-Z_]+$/.test(error.message))
    return error.message
  return 'E0_VALIDATION'
}

ponder.on(
  'easOffchainAnchorRegistry:NodeRegistered',
  async ({ event, context }) => {
    await context.db.insert(easOffchainRegistration).values({
      registry: event.log.address,
      nodeId: event.args.nodeId,
      owner: event.args.owner,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
  }
)

ponder.on(
  'easOffchainAnchorRegistry:HeadAnchored',
  async ({ event, context }) => {
    const registry = event.log.address
    const lane = await context.db.find(easOffchainLane, { registry })
    if (!lane) {
      console.error(
        `eas-offchain: registry ${registry} was not authenticated by a factory event; skipping`
      )
      return
    }
    const previous = await context.db.find(easOffchainNode, {
      registry,
      nodeId: event.args.nodeId,
    })
    // Capture this scalar before the node upsert. Ponder's entity cache may update the object
    // returned by `find` in place; reading `previous.count` after `onConflictDoUpdate` then observes
    // the NEW count and undercounts the aggregate delta (the live two-head e2e caught 6 vs 10 work).
    const previousCount = previous?.count ?? 0n
    const registration = await context.db.find(easOffchainRegistration, {
      registry,
      nodeId: event.args.nodeId,
    })
    const cid = rawCid(event.args.dataCommitment)
    let fetched: FetchResult | null = null
    let payload:
      | Awaited<ReturnType<typeof validateSignedBundle>>['payload']
      | null = null
    let commits: CommitAnchor[] = []
    let validationError: string | null = null
    try {
      if (
        !registration ||
        getAddress(registration.owner) !== getAddress(event.args.owner)
      )
        throw new Error('E0_REGISTRATION')
      if (
        event.args.envelopeKind !== 0 ||
        event.args.schemaUid.toLowerCase() !== lane.schemaUid.toLowerCase()
      )
        throw new Error('E0_LANE_CONFIG')
      const expectedPrevious = previous?.head ?? ZERO32
      if (
        event.args.previousHead.toLowerCase() !==
          expectedPrevious.toLowerCase() ||
        event.args.count <= previousCount ||
        event.args.foldIndex !== lane.anchorCount
      )
        throw new Error('E0_TRANSITION')

      fetched = await fetchCanonicalPayload(event.args.dataCommitment)
      const bundle: SignedAnchorBundle = {
        protocol: 'TrustgraphsEasOffchainBundleV1',
        chainId: lane.chainId,
        registry: getAddress(registry),
        eas: { address: getAddress(lane.eas), version: lane.easVersion },
        schemaUid: event.args.schemaUid,
        owner: getAddress(event.args.owner),
        payloadHex: fetched.payloadHex,
        cid,
        dataCommitment: event.args.dataCommitment,
        message: {
          nodeId: event.args.nodeId,
          envelopeKind: 0,
          schemaUid: event.args.schemaUid,
          previousHead: event.args.previousHead,
          head: event.args.head,
          count: event.args.count.toString(),
          dataCommitment: event.args.dataCommitment,
        },
        headSignature: event.args.headSignature,
      }
      const validated = await validateSignedBundle(bundle)
      payload = validated.payload
      const heads = prefixHeads(payload)
      const prefix =
        previousCount === 0n ? ZERO32 : heads[Number(previousCount) - 1]
      if (prefix?.toLowerCase() !== expectedPrevious.toLowerCase())
        throw new Error('E0_PREVIOUS_HEAD')
      const priorAnchors = await context.db.sql
        .select({
          id: easOffchainAnchor.id,
          count: easOffchainAnchor.count,
          foldIndex: easOffchainAnchor.foldIndex,
          blockTimestamp: easOffchainAnchor.blockTimestamp,
          txHash: easOffchainAnchor.txHash,
          blockNumber: easOffchainAnchor.blockNumber,
        })
        .from(easOffchainAnchor)
        .where(
          and(
            eq(easOffchainAnchor.registry, registry),
            eq(easOffchainAnchor.nodeId, event.args.nodeId)
          )
        )
        .orderBy(asc(easOffchainAnchor.foldIndex))
      commits = [
        ...priorAnchors,
        {
          id: event.id,
          count: event.args.count,
          foldIndex: event.args.foldIndex,
          blockTimestamp: event.args.blockTimestamp,
          txHash: event.transaction.hash,
          blockNumber: event.block.number,
        },
      ]
      const bodies = new Map(
        payload.attestations.map((attestation) => [
          attestation.uid.toLowerCase(),
          attestation,
        ])
      )
      for (const [position, entry] of payload.entries.entries()) {
        if (entry.kind !== 0) continue
        const body = bodies.get(entry.uid.toLowerCase())
        const firstCommit = commits.find(
          (commit) => commit.count > BigInt(position)
        )
        if (!body || !firstCommit || body.time > firstCommit.blockTimestamp)
          throw new Error('E0_TIME')
      }
    } catch (error) {
      validationError = errorCode(error)
      console.warn(
        `eas-offchain: anchor ${event.id} failed independent verification (${validationError})`
      )
    }

    const verified = payload !== null && validationError === null
    await context.db.insert(easOffchainAnchor).values({
      id: event.id,
      registry,
      instanceId: lane.instanceId,
      foldIndex: event.args.foldIndex,
      nodeId: event.args.nodeId,
      owner: event.args.owner,
      envelopeKind: event.args.envelopeKind,
      schemaUid: event.args.schemaUid,
      previousHead: event.args.previousHead,
      head: event.args.head,
      count: event.args.count,
      dataCommitment: event.args.dataCommitment,
      cid,
      headSignature: event.args.headSignature,
      payloadHex: fetched?.payloadHex ?? null,
      payloadBytes: fetched?.bytes ?? null,
      verified,
      validationError,
      gatewayIndex: fetched?.gatewayIndex ?? null,
      fetchLatencyMs: fetched?.latencyMs ?? null,
      blockTimestamp: event.args.blockTimestamp,
      txHash: event.transaction.hash,
      blockNumber: event.block.number,
    })

    await context.db
      .insert(easOffchainNode)
      .values({
        registry,
        nodeId: event.args.nodeId,
        owner: event.args.owner,
        anchorId: event.id,
        head: event.args.head,
        previousHead: event.args.previousHead,
        count: event.args.count,
        dataCommitment: event.args.dataCommitment,
        cid,
        verified,
        validationError,
        updatedBlock: event.block.number,
        updatedTimestamp: event.block.timestamp,
        updatedTxHash: event.transaction.hash,
      })
      .onConflictDoUpdate({
        owner: event.args.owner,
        anchorId: event.id,
        head: event.args.head,
        previousHead: event.args.previousHead,
        count: event.args.count,
        dataCommitment: event.args.dataCommitment,
        cid,
        verified,
        validationError,
        updatedBlock: event.block.number,
        updatedTimestamp: event.block.timestamp,
        updatedTxHash: event.transaction.hash,
      })

    const aggregateEntryCount =
      lane.aggregateEntryCount - previousCount + event.args.count
    const anchorCount = event.args.foldIndex + 1n
    await context.db.update(easOffchainLane, { registry }).set({
      anchorCount,
      aggregateEntryCount,
      workCount: anchorCount + aggregateEntryCount * 4n,
      validationFailures: lane.validationFailures + (verified ? 0n : 1n),
      lastAnchorBlock: event.block.number,
      lastVerifiedBlock: verified ? event.block.number : lane.lastVerifiedBlock,
    })

    if (!payload) return
    const bodies = new Map<string, CanonicalAttestation>(
      payload.attestations.map((attestation) => [
        attestation.uid.toLowerCase(),
        attestation,
      ])
    )
    for (const [sequence, entry] of payload.entries.entries()) {
      const attestation = bodies.get(entry.uid.toLowerCase())
      const firstAnchor = commits.find(
        (commit) => commit.count > BigInt(sequence)
      )
      // `validateSignedBundle` plus the first-commit checks above already prove both facts. Keep
      // this guard anyway: a derived row must never be written from an incomplete local mapping.
      if (!attestation || !firstAnchor) {
        throw new Error('E0_DERIVED_MUTATION')
      }
      await context.db.insert(easOffchainMutation).values({
        id: `${event.id}-${sequence}-${entry.kind}-${entry.uid}`,
        anchorId: event.id,
        registry,
        nodeId: event.args.nodeId,
        kind: entry.kind,
        uid: entry.uid,
        recipient: attestation.recipient,
        time: entry.kind === 0 ? attestation.time : firstAnchor.blockTimestamp,
        signedTime: attestation.time,
        data: attestation.data,
        sequence,
        firstAnchorId: firstAnchor.id,
        firstAnchorFoldIndex: firstAnchor.foldIndex,
        firstAnchorBlock: firstAnchor.blockNumber,
        firstAnchorTimestamp: firstAnchor.blockTimestamp,
        firstAnchorTxHash: firstAnchor.txHash,
        blockNumber: event.block.number,
      })
    }
  }
)
