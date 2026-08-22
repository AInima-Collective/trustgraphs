import {
  type Address,
  type Hex,
  isAddress,
  isHex,
  keccak256,
  stringToHex,
} from 'viem'

import { hashPair } from '../pagerank/merkle'
import {
  type ScoreProgramProvenance,
  parseScoreProgramProvenance,
} from '../score-program'
import { nodeOutputLeaf } from './recompute'

export type NostrArchiveAccessPolicy =
  | 'public'
  | 'member-scoped'
  | 'private-operator'
export type NostrEpochTrustClass =
  | 'relay-exporter-attested'
  | 'relay-exporter-attested+member-self-committed'
export type NostrActorKind = 'member' | 'agent'

export type NostrWorkspaceScore = {
  nodeId: Hex
  nostrPubkey: Hex
  actorKind: NostrActorKind
  ownerNodeId: Hex | null
  boundAddress: Address | null
  value: string
  proof: Hex[]
}

export type NostrWorkspaceScorePage = {
  snapshot: Address
  root: Hex
  checkpointId: string
  ipfsHash: Hex
  ipfsHashCid: string
  numNodes: number
  totalValue: string
  skippedDigest: Hex
  anchorAcc: Hex
  anchorCount: string
  accessPolicy: NostrArchiveAccessPolicy
  epochTrustClass: NostrEpochTrustClass
  reducedRecomputeStatus: 'production-core-and-output-root-reproduced'
  skipSummary: Record<string, number>
  archiveProvenance: Record<string, unknown>
  blockNumber: string
  timestamp: string
  scoreProgram: ScoreProgramProvenance
  scores: NostrWorkspaceScore[]
  page: { limit: number; offset: number; total: number }
}

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is malformed`)
  }
  return value as Record<string, unknown>
}
const hex32 = (value: unknown, label: string): Hex => {
  if (typeof value !== 'string' || !isHex(value) || value.length !== 66) {
    throw new Error(`${label} is malformed`)
  }
  return value.toLowerCase() as Hex
}
const address = (value: unknown, label: string): Address => {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new Error(`${label} is malformed`)
  }
  return value.toLowerCase() as Address
}
const decimal = (value: unknown, label: string, allowZero = true) => {
  if (
    typeof value !== 'string' ||
    !(allowZero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(value)
  ) {
    throw new Error(`${label} is malformed`)
  }
  return value
}
const safeInteger = (value: unknown, label: string) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is malformed`)
  }
  return value
}

const FORBIDDEN_ARCHIVE_KEYS = new Set([
  'content',
  'eventcontent',
  'eventbytes',
  'plaintext',
  'credential',
  'credentials',
  'databaseurl',
  'dsn',
  'secret',
])

/** Prevent a rolling/misconfigured indexer from placing scoped witness material in this view. */
const requireRedactedArchive = (value: unknown, depth = 0): void => {
  if (depth > 8) throw new Error('archive provenance nesting is excessive')
  if (Array.isArray(value)) {
    for (const item of value) requireRedactedArchive(item, depth + 1)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_ARCHIVE_KEYS.has(key.toLowerCase())) {
      throw new Error(`archive provenance exposes forbidden field ${key}`)
    }
    requireRedactedArchive(child, depth + 1)
  }
}

export const nostrNodeId = (pubkey: Hex): Hex =>
  keccak256(stringToHex(`did:nostr:${pubkey.slice(2).toLowerCase()}`))

const parseScore = (value: unknown, root: Hex): NostrWorkspaceScore => {
  const row = record(value, 'Nostr score row')
  const nodeId = hex32(row.nodeId, 'Nostr nodeId')
  const nostrPubkey = hex32(row.nostrPubkey, 'Nostr pubkey')
  if (nostrNodeId(nostrPubkey) !== nodeId) {
    throw new Error('Nostr pubkey does not derive the served nodeId')
  }
  if (row.actorKind !== 'member' && row.actorKind !== 'agent') {
    throw new Error('Nostr actor kind is malformed')
  }
  const ownerNodeId =
    row.ownerNodeId === null
      ? null
      : hex32(row.ownerNodeId, 'Nostr agent owner nodeId')
  if (
    (row.actorKind === 'member' && ownerNodeId !== null) ||
    (row.actorKind === 'agent' && ownerNodeId === null)
  ) {
    throw new Error('Nostr owner provenance conflicts with actor kind')
  }
  const boundAddress =
    row.boundAddress === null
      ? null
      : address(row.boundAddress, 'Nostr EVM binding')
  const score = decimal(row.value, 'Nostr score', false)
  if (!Array.isArray(row.proof))
    throw new Error('Nostr score proof is malformed')
  const proof = row.proof.map((item) => hex32(item, 'Nostr proof sibling'))
  const reached = proof.reduce(
    (acc, sibling) => hashPair(acc, sibling),
    nodeOutputLeaf(nodeId, BigInt(score))
  )
  if (reached.toLowerCase() !== root.toLowerCase()) {
    throw new Error('Nostr score proof does not reproduce the proven root')
  }
  return {
    nodeId,
    nostrPubkey,
    actorKind: row.actorKind,
    ownerNodeId,
    boundAddress,
    value: score,
    proof,
  }
}

/** Runtime-authenticate and type the indexer's content-free instance response. */
export const parseNostrWorkspaceScorePage = (
  value: unknown
): NostrWorkspaceScorePage => {
  const page = record(value, 'Nostr workspace response')
  const snapshot = address(page.snapshot, 'Nostr snapshot')
  const root = hex32(page.root, 'Nostr root')
  const scoreProgram = parseScoreProgramProvenance(
    page.scoreProgram,
    'nostr-workspace'
  )
  if (scoreProgram.registryOrAccumulator.toLowerCase() === snapshot) {
    throw new Error(
      'Nostr score provenance confuses the anchor registry with the snapshot'
    )
  }
  if (!Array.isArray(page.scores))
    throw new Error('Nostr score page is malformed')
  const pagination = record(page.page, 'Nostr pagination')
  const limit = safeInteger(pagination.limit, 'Nostr page limit')
  const offset = safeInteger(pagination.offset, 'Nostr page offset')
  const total = safeInteger(pagination.total, 'Nostr page total')
  if (limit > 200 || page.scores.length > limit || offset > total) {
    throw new Error('Nostr pagination exceeds its authenticated bounds')
  }
  const accessPolicy = page.accessPolicy
  if (
    accessPolicy !== 'public' &&
    accessPolicy !== 'member-scoped' &&
    accessPolicy !== 'private-operator'
  ) {
    throw new Error('Nostr archive access policy is malformed')
  }
  const epochTrustClass = page.epochTrustClass
  if (
    epochTrustClass !== 'relay-exporter-attested' &&
    epochTrustClass !== 'relay-exporter-attested+member-self-committed'
  ) {
    throw new Error('Nostr epoch trust class is malformed')
  }
  if (
    page.reducedRecomputeStatus !== 'production-core-and-output-root-reproduced'
  ) {
    throw new Error(
      'Nostr reduced-recompute status is not production-authenticated'
    )
  }
  const skipSummaryRaw = record(page.skipSummary, 'Nostr skip summary')
  const skipSummary: Record<string, number> = {}
  for (const [reason, count] of Object.entries(skipSummaryRaw)) {
    if (!/^(0|[1-9][0-9]*)$/.test(reason)) {
      throw new Error('Nostr skip reason is malformed')
    }
    skipSummary[reason] = safeInteger(count, 'Nostr skip count')
  }
  const archiveProvenance = record(
    page.archiveProvenance,
    'Nostr archive provenance'
  )
  requireRedactedArchive(archiveProvenance)
  return {
    snapshot,
    root,
    checkpointId: decimal(page.checkpointId, 'Nostr checkpoint'),
    ipfsHash: hex32(page.ipfsHash, 'Nostr score blob digest'),
    ipfsHashCid:
      typeof page.ipfsHashCid === 'string' && page.ipfsHashCid.length <= 256
        ? page.ipfsHashCid
        : (() => {
            throw new Error('Nostr score blob CID is malformed')
          })(),
    numNodes: safeInteger(page.numNodes, 'Nostr node count'),
    totalValue: decimal(page.totalValue, 'Nostr total score'),
    skippedDigest: hex32(page.skippedDigest, 'Nostr skipped digest'),
    anchorAcc: hex32(page.anchorAcc, 'Nostr anchor accumulator'),
    anchorCount: decimal(page.anchorCount, 'Nostr anchor count'),
    accessPolicy,
    epochTrustClass,
    reducedRecomputeStatus: page.reducedRecomputeStatus,
    skipSummary,
    archiveProvenance,
    blockNumber: decimal(page.blockNumber, 'Nostr block number'),
    timestamp: decimal(page.timestamp, 'Nostr timestamp'),
    scoreProgram,
    scores: page.scores.map((score) => parseScore(score, root)),
    page: { limit, offset, total },
  }
}

export const fetchNostrWorkspaceScorePage = async (
  indexerUrl: string,
  snapshot: string,
  options: { root?: string; limit?: number; offset?: number } = {}
) => {
  if (!isAddress(snapshot, { strict: false }))
    throw new Error('invalid Nostr snapshot')
  const query = new URLSearchParams({
    root: options.root ?? 'current',
    limit: String(options.limit ?? 50),
    offset: String(options.offset ?? 0),
  })
  const response = await fetch(
    `${indexerUrl}/nostr-workspace/${snapshot}/scores?${query}`
  )
  if (!response.ok) {
    throw new Error(
      `Nostr workspace lookup failed: ${response.status} ${await response.text()}`
    )
  }
  return parseNostrWorkspaceScorePage(await response.json())
}
