import {
  type LiveNodeHead,
  type PayloadV1,
  type SignedAnchorBundle,
  ZERO32,
  addressNodeId,
  bytesToHex,
  payloadCommitment,
  prefixHeads,
  rawCid,
  recoverHeadSigner,
  validateSignedBundle,
} from '@trustgraphs/eas-offchain-client'
import { type Address, type Hex, getAddress } from 'viem'

import { APIS } from './config'
import type { RawEdge } from './pagerank/types'

const splitPublicList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

const unique = (values: string[]): string[] => Array.from(new Set(values))

/** Browser-facing relays only. Their public URLs never carry storage credentials. */
export const easOffchainRelayUrls = (): string[] =>
  unique(splitPublicList(process.env.NEXT_PUBLIC_EAS_OFFCHAIN_RELAY_URLS)).map(
    (url) => url.replace(/\/$/, '')
  )

/** Independent raw-CID readers used for browser verification and conflict reloads. */
export const easOffchainGatewayUrls = (): string[] =>
  unique([
    ...splitPublicList(process.env.NEXT_PUBLIC_EAS_OFFCHAIN_GATEWAYS),
    ...(APIS.ipfsGateway ? [APIS.ipfsGateway] : []),
  ])

const cidUrl = (gateway: string, cid: string): string => {
  if (gateway.includes('{cid}')) return gateway.replaceAll('{cid}', cid)
  return `${gateway.replace(/\/$/, '')}/${cid}`
}

const json = async <T>(response: Response, label: string): Promise<T> => {
  const body = (await response.json().catch(() => null)) as T | null
  if (!response.ok || body === null) {
    throw new Error(`${label} responded ${response.status}`)
  }
  return body
}

export type StrictLaneConfig = {
  registry: Address
  instanceId: Hex
  chainId: string
  eas: Address
  easVersion: string
  schemaUid: Hex
  domainSeparator: Hex
  maxTotalInputs: string
  workCount: string
  anchorCount: string
  validationFailures: string
}

export type StrictNode = {
  registry: Address
  nodeId: Hex
  owner: Address
  anchorId: string
  head: Hex
  previousHead: Hex
  count: string
  dataCommitment: Hex
  cid: string
  verified: boolean
  validationError: string | null
  updatedBlock: string
  updatedTimestamp: string
}

export type StrictAnchor = {
  id: string
  registry: Address
  foldIndex: string
  nodeId: Hex
  owner: Address
  schemaUid: Hex
  previousHead: Hex
  head: Hex
  count: string
  dataCommitment: Hex
  cid: string
  headSignature: Hex
  verified: boolean
  validationError: string | null
  blockTimestamp: string
  blockNumber: string
}

export const readStrictLaneConfig = async (
  registry: Address
): Promise<StrictLaneConfig> => {
  const response = await fetch(
    `${APIS.ponder}/eas-offchain/${registry}/config`,
    { cache: 'no-store' }
  )
  const body = await json<{ lane: StrictLaneConfig }>(
    response,
    'Strict lane config'
  )
  return body.lane
}

export const readStrictNodes = async (
  registry: Address
): Promise<StrictNode[]> => {
  const response = await fetch(
    `${APIS.ponder}/eas-offchain/${registry}/nodes`,
    { cache: 'no-store' }
  )
  return (await json<{ nodes: StrictNode[] }>(response, 'Strict node list'))
    .nodes
}

export const readStrictHistory = async (
  registry: Address,
  nodeId: Hex
): Promise<StrictAnchor[]> => {
  const response = await fetch(
    `${APIS.ponder}/eas-offchain/${registry}/nodes/${nodeId}/history`,
    { cache: 'no-store' }
  )
  return (
    await json<{ history: StrictAnchor[] }>(response, 'Strict node history')
  ).history
}

export const readStrictNode = async (
  registry: Address,
  owner: Address
): Promise<StrictNode | undefined> => {
  const nodeId = addressNodeId(owner)
  const response = await fetch(
    `${APIS.ponder}/eas-offchain/${registry}/nodes/${nodeId}`,
    { cache: 'no-store' }
  )
  if (response.status === 404) return undefined
  return (await json<{ node: StrictNode }>(response, 'Strict node head')).node
}

/** Fetch one raw block from any configured reader and verify its SHA-256 CID commitment. */
export const fetchExactOffchainPayload = async (
  commitment: Hex
): Promise<{ bytes: Uint8Array; cid: string; reader: number }> => {
  const cid = rawCid(commitment)
  const gateways = easOffchainGatewayUrls()
  if (gateways.length === 0) {
    throw new Error(
      'No public off-chain payload reader is configured. Add a raw-CID gateway and retry.'
    )
  }
  const failures: string[] = []
  for (const [reader, gateway] of gateways.entries()) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 20_000)
      const response = await fetch(cidUrl(gateway, cid), {
        cache: 'no-store',
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout))
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (payloadCommitment(bytes).toLowerCase() !== commitment.toLowerCase()) {
        throw new Error('SHA-256 commitment mismatch')
      }
      return { bytes, cid, reader }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : 'reader failed')
    }
  }
  throw new Error(
    `The retained payload is unavailable or corrupt on every configured reader (${failures.join('; ')}). Retry or ask an operator to re-pin the exact CID ${cid}.`
  )
}

export const canonicalStrictNode = async (args: {
  registry: Address
  owner: Address
  schemaUid: Hex
}): Promise<{
  live: LiveNodeHead
  payload?: PayloadV1
  node?: StrictNode
}> => {
  const node = await readStrictNode(args.registry, args.owner)
  if (!node) {
    return {
      live: { count: 0n, head: ZERO32, dataCommitment: ZERO32 },
    }
  }
  if (!node.verified) {
    throw new Error(
      `The latest indexed payload failed independent verification (${node.validationError ?? 'unknown validation error'}). Do not sign a successor until it is repaired.`
    )
  }
  const [lane, history, fetched] = await Promise.all([
    readStrictLaneConfig(args.registry),
    readStrictHistory(args.registry, node.nodeId),
    fetchExactOffchainPayload(node.dataCommitment),
  ])
  const current = history.find((anchor) => anchor.id === node.anchorId)
  if (!current?.verified) {
    throw new Error('The current strict anchor is unavailable or unverified.')
  }
  const validated = await validateSignedBundle(
    bundleFrom(lane, current, bytesToHex(fetched.bytes))
  )
  const payload = validated.payload
  if (getAddress(payload.owner) !== getAddress(args.owner)) {
    throw new Error('The canonical payload belongs to a different EOA.')
  }
  if (
    validated.message.head.toLowerCase() !== node.head.toLowerCase() ||
    validated.message.count !== BigInt(node.count)
  ) {
    throw new Error(
      'The canonical payload does not match the finalized node head.'
    )
  }
  const chronological = await verifyAnchorHistory(
    lane,
    getAddress(args.owner),
    node.nodeId,
    payload,
    history
  )
  const bodies = new Map(
    payload.attestations.map((attestation) => [
      attestation.uid.toLowerCase(),
      attestation,
    ])
  )
  for (const [position, entry] of payload.entries.entries()) {
    if (entry.kind !== 0) continue
    const body = bodies.get(entry.uid.toLowerCase())
    const firstAnchor = chronological.find(
      (anchor) => BigInt(anchor.count) > BigInt(position)
    )
    if (
      !body ||
      !firstAnchor ||
      body.time > BigInt(firstAnchor.blockTimestamp)
    ) {
      throw new Error(`Attestation ${entry.uid} has an invalid commit time.`)
    }
  }
  return {
    live: {
      count: BigInt(node.count),
      head: node.head,
      dataCommitment: node.dataCommitment,
    },
    payload,
    node,
  }
}

const bundleFrom = (
  lane: StrictLaneConfig,
  anchor: StrictAnchor,
  payloadHex: Hex
): SignedAnchorBundle => ({
  protocol: 'TrustgraphsEasOffchainBundleV1',
  chainId: lane.chainId,
  registry: getAddress(lane.registry),
  eas: { address: getAddress(lane.eas), version: lane.easVersion },
  schemaUid: lane.schemaUid,
  owner: getAddress(anchor.owner),
  payloadHex,
  cid: anchor.cid,
  dataCommitment: anchor.dataCommitment,
  message: {
    nodeId: anchor.nodeId,
    envelopeKind: 0,
    schemaUid: anchor.schemaUid,
    previousHead: anchor.previousHead,
    head: anchor.head,
    count: anchor.count,
    dataCommitment: anchor.dataCommitment,
  },
  headSignature: anchor.headSignature,
})

const verifyAnchorHistory = async (
  lane: StrictLaneConfig,
  owner: Address,
  nodeId: Hex,
  payload: PayloadV1,
  history: StrictAnchor[]
): Promise<StrictAnchor[]> => {
  const heads = prefixHeads(payload)
  const chronological = [...history].sort((left, right) =>
    BigInt(left.foldIndex) < BigInt(right.foldIndex)
      ? -1
      : BigInt(left.foldIndex) > BigInt(right.foldIndex)
        ? 1
        : 0
  )
  let previousCount = 0n
  let previousHead = ZERO32
  for (const anchor of chronological) {
    const count = BigInt(anchor.count)
    const expectedHead = heads[Number(count - 1n)]
    if (
      anchor.nodeId.toLowerCase() !== nodeId.toLowerCase() ||
      getAddress(anchor.owner) !== getAddress(owner) ||
      anchor.schemaUid.toLowerCase() !== lane.schemaUid.toLowerCase() ||
      count <= previousCount ||
      anchor.previousHead.toLowerCase() !== previousHead.toLowerCase() ||
      !expectedHead ||
      expectedHead.toLowerCase() !== anchor.head.toLowerCase()
    ) {
      throw new Error(
        `Historical anchor ${anchor.id} is not a canonical prefix.`
      )
    }
    const signer = await recoverHeadSigner(
      {
        nodeId: anchor.nodeId,
        envelopeKind: 0,
        schemaUid: anchor.schemaUid,
        previousHead: anchor.previousHead,
        head: anchor.head,
        count,
        dataCommitment: anchor.dataCommitment,
      },
      anchor.headSignature,
      BigInt(lane.chainId),
      getAddress(lane.registry)
    )
    if (getAddress(signer) !== getAddress(owner)) {
      throw new Error(
        `Historical head ${anchor.id} was signed by another owner.`
      )
    }
    previousCount = count
    previousHead = anchor.head
  }
  return chronological
}

export type StrictAudit = {
  mode: 'independent-envelope0-browser-verification'
  lane: StrictLaneConfig
  nodes: number
  entries: number
  edges: RawEdge[]
  verifiedAt: string
}

/**
 * Rebuild every current strict node from chain-derived index rows plus exact raw CIDs. This checks
 * digest, canonical codec, EAS signatures, owner/head signature, head/count and anchor prefixes.
 */
export const auditStrictLane = async (
  registry: Address
): Promise<StrictAudit> => {
  const [lane, nodes] = await Promise.all([
    readStrictLaneConfig(registry),
    readStrictNodes(registry),
  ])
  const positionedEdges: Array<{
    edge: RawEdge
    anchorFold: bigint
    sequence: number
  }> = []
  let entries = 0
  for (const node of nodes) {
    if (!node.verified) {
      throw new Error(
        `Node ${node.nodeId} is not independently verified (${node.validationError ?? 'unknown validation error'}).`
      )
    }
    const history = await readStrictHistory(registry, node.nodeId)
    const current = history.find((anchor) => anchor.id === node.anchorId)
    if (!current?.verified) {
      throw new Error(
        `Current anchor ${node.anchorId} is unavailable or unverified.`
      )
    }
    const fetched = await fetchExactOffchainPayload(current.dataCommitment)
    const payloadHex = bytesToHex(fetched.bytes)
    const validated = await validateSignedBundle(
      bundleFrom(lane, current, payloadHex)
    )
    if (
      validated.message.head.toLowerCase() !== node.head.toLowerCase() ||
      validated.message.count !== BigInt(node.count)
    ) {
      throw new Error(`Node ${node.nodeId} does not match its current anchor.`)
    }

    const attestations = new Map(
      validated.payload.attestations.map((attestation) => [
        attestation.uid.toLowerCase(),
        attestation,
      ])
    )
    const firstCommit = await verifyAnchorHistory(
      lane,
      getAddress(node.owner),
      node.nodeId,
      validated.payload,
      history
    )
    for (const [position, entry] of validated.payload.entries.entries()) {
      const body = attestations.get(entry.uid.toLowerCase())
      if (!body) throw new Error(`Entry ${entry.uid} has no signed body.`)
      const firstAnchor = firstCommit.find(
        (anchor) => BigInt(anchor.count) > BigInt(position)
      )
      if (!firstAnchor) {
        throw new Error(`Entry ${entry.uid} has no first-commit anchor.`)
      }
      if (entry.kind === 0 && body.time > BigInt(firstAnchor.blockTimestamp)) {
        throw new Error(
          `Attestation ${entry.uid} claims a time after its first anchor.`
        )
      }
      const effectiveTime =
        entry.kind === 0 ? body.time : BigInt(firstAnchor.blockTimestamp)
      positionedEdges.push({
        anchorFold: BigInt(firstAnchor.foldIndex),
        sequence: position,
        edge: {
          kind: entry.kind,
          attester: validated.payload.owner.toLowerCase() as Hex,
          recipient: body.recipient.toLowerCase() as Hex,
          uid: entry.uid,
          blockTimestamp: effectiveTime,
          data: body.data,
        },
      })
      entries += 1
    }
  }
  return {
    mode: 'independent-envelope0-browser-verification',
    lane,
    nodes: nodes.length,
    entries,
    edges: positionedEdges
      .sort((left, right) =>
        left.anchorFold < right.anchorFold
          ? -1
          : left.anchorFold > right.anchorFold
            ? 1
            : left.sequence - right.sequence
      )
      .map(({ edge }) => edge),
    verifiedAt: new Date().toISOString(),
  }
}
