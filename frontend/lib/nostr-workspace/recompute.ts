//! Reduced-tier browser recomputation for `nostr-workspace`.
//!
//! The input rows have already passed TGNW, audit-chain, NIP-01, and NIP-OA verification in the
//! guest. This module repeats the deterministic V1/G1/J1/F1 semantics, rank, distribution, tree,
//! blob/CID, skip fold, params encoding, and journal encoding. It intentionally does not claim to
//! verify BIP-340 signatures or relay completeness in the browser.

import { type Hex, concat, keccak256, stringToBytes, toBytes } from 'viem'

import {
  canonicalBlob,
  cidV1Raw,
  digestToHex,
  sha256Utf8,
} from '../pagerank/cid'
import { distributePoints } from '../pagerank/distribute'
import { journalDigest as encodeJournalDigest, fold } from '../pagerank/encode'
import { merkleRoot, outputLeaf } from '../pagerank/merkle'
import { calculate } from '../pagerank/pagerank'
import { type Graph } from '../pagerank/reconcile'
import { type Journal, type Params as RankParams } from '../pagerank/types'
import {
  ZERO_HASH,
  cmpHex,
  wordU256,
  wordU32,
  wordU64,
  wordU8,
} from '../pagerank/words'

export interface NostrLimits {
  envelopeBytes: number
  selectedHeads: number
  auditEntries: number
  events: number
  encodedEventBytes: number
  contentBytes: number
  tagsPerEvent: number
  elementsPerTag: number
  tagStringBytes: number
  allTagStringsBytes: number
  auditDetailBytes: number
  nip01Signatures: number
  oaSignatures: number
}

export interface NostrWorkspaceParams {
  version: number
  outputDomain: Hex
  dampingFp: bigint
  toleranceFp: bigint
  maxIterations: number
  trustMultiplierFp: bigint
  trustShareFp: bigint
  trustDecayFp: bigint
  precisionScale: bigint
  totalPool: bigint
  trustedSeedPubkeys: Hex[]
  communityId: Hex
  instanceDomain: Hex
  relayPubkey: Hex
  chainId: bigint
  allowedVariants: number
  wVouchFp: bigint
  wMergeFp: bigint
  wJobFp: bigint
  wForumFp: bigint
  relayAttestedWeightFp: bigint
  forumPairCap: number
  jobPairCap: number
  lane2MaxHeadAge: bigint
  maxAnchorRecords: number
  maxEstimatedPgu: bigint
  limits: NostrLimits
}

export interface AuthenticatedEvent {
  id: Hex
  pubkey: Hex
  createdAt: string
  kind: number
  tags: string[][]
  content: string
  oaOwner: Hex | null
  disposition: { accepted: boolean; reason?: number }
  provenance: 1 | 2
  order: [string, number]
  observedAt: string
}

export interface SkippedNode {
  nodeId: Hex
  reason: number
  epochObserved: string | bigint | number
}

export interface Binding {
  nodeId: Hex
  address: Hex
}

export interface RecomputeInput {
  events: AuthenticatedEvent[]
  rosterPubkeys: Hex[]
  bindings: Binding[]
  skips: SkippedNode[]
  params: NostrWorkspaceParams
  anchorAcc: Hex
  anchorCount: bigint
  binding: { recipient: Hex; instanceDomain: Hex }
}

export interface DerivedSemantics {
  graph: Graph
  edges: Array<{ source: Hex; target: Hex; weightFp: bigint }>
  agents: Array<{ agent: Hex; owner: Hex }>
}

const lower = (value: Hex): Hex => value.toLowerCase() as Hex
const strip0x = (value: Hex): string => value.slice(2).toLowerCase()
const hex32 = (value: string): Hex | null =>
  /^[0-9a-f]{64}$/.test(value) ? (`0x${value}` as Hex) : null
const canonicalUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const isCommit = (value: string): boolean =>
  (value.length === 40 || value.length === 64) && /^[0-9a-f]+$/.test(value)
const canonicalU32 = (value: string, maximum: number): number | null => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null
}
const utf8Length = (value: string): number => stringToBytes(value).length

const tagsNamed = (event: AuthenticatedEvent, name: string): string[][] =>
  event.tags.filter((tag) => tag[0] === name)
const soleTag = (event: AuthenticatedEvent, name: string): string[] | null => {
  const tags = tagsNamed(event, name)
  return tags.length === 1 ? tags[0] : null
}
const exactTwo = (event: AuthenticatedEvent, name: string): string | null => {
  const tag = soleTag(event, name)
  return tag?.length === 2 ? tag[1] : null
}

export const nostrNodeId = (pubkey: Hex): Hex =>
  keccak256(toBytes(`did:nostr:${strip0x(pubkey)}`))

export const nodeOutputLeaf = (nodeId: Hex, value: bigint): Hex =>
  keccak256(keccak256(concat([nodeId, wordU256(value)])))

export const seedSetRoot = (pubkeys: Hex[]): Hex => {
  const ids = pubkeys.map(nostrNodeId).sort(cmpHex)
  return merkleRoot(ids.map((id) => keccak256(id)))
}

const wordBytes16 = (value: Hex): Hex => {
  if (strip0x(value).length !== 32)
    throw new Error('communityId must be bytes16')
  return `${value}${'00'.repeat(16)}` as Hex
}

export const paramsEncoded = (p: NostrWorkspaceParams): Hex => {
  const l = p.limits
  return concat([
    wordU32(p.version),
    p.outputDomain,
    wordU256(p.dampingFp),
    wordU256(p.toleranceFp),
    wordU32(p.maxIterations),
    wordU256(p.trustMultiplierFp),
    wordU256(p.trustShareFp),
    wordU256(p.trustDecayFp),
    wordU256(p.precisionScale),
    wordU256(p.totalPool),
    seedSetRoot(p.trustedSeedPubkeys),
    wordBytes16(p.communityId),
    p.instanceDomain,
    p.relayPubkey,
    wordU64(p.chainId),
    wordU8(p.allowedVariants),
    wordU256(p.wVouchFp),
    wordU256(p.wMergeFp),
    wordU256(p.wJobFp),
    wordU256(p.wForumFp),
    wordU256(p.relayAttestedWeightFp),
    wordU32(p.forumPairCap),
    wordU32(p.jobPairCap),
    wordU64(p.lane2MaxHeadAge),
    wordU32(p.maxAnchorRecords),
    wordU64(p.maxEstimatedPgu),
    wordU32(l.envelopeBytes),
    wordU32(l.selectedHeads),
    wordU32(l.auditEntries),
    wordU32(l.events),
    wordU32(l.encodedEventBytes),
    wordU32(l.contentBytes),
    wordU32(l.tagsPerEvent),
    wordU32(l.elementsPerTag),
    wordU32(l.tagStringBytes),
    wordU32(l.allTagStringsBytes),
    wordU32(l.auditDetailBytes),
    wordU32(l.nip01Signatures),
    wordU32(l.oaSignatures),
  ])
}

export const paramsHash = (p: NostrWorkspaceParams): Hex =>
  keccak256(paramsEncoded(p))

const repoCoordinate = (value: string): Hex | null => {
  const fields = value.split(':')
  if (fields.length !== 3 || fields[0] !== '30617') return null
  const owner = hex32(fields[1])
  const repo = fields[2]
  if (
    !owner ||
    repo.length === 0 ||
    repo.length > 64 ||
    repo.startsWith('.') ||
    repo.includes('..') ||
    !/^[A-Za-z0-9._-]+$/.test(repo)
  )
    return null
  return owner
}

const validVouch = (e: AuthenticatedEvent): [Hex, number] | null => {
  if (e.kind !== 36382 || e.content !== '') return null
  const authCount = tagsNamed(e, 'auth').length
  if (e.tags.length !== 2 + authCount || authCount > 1) return null
  if (!e.tags.every((tag) => ['d', 'weight', 'auth'].includes(tag[0] ?? '')))
    return null
  const subject = exactTwo(e, 'd')
  const weight = exactTwo(e, 'weight')
  const parsedSubject = subject ? hex32(subject) : null
  const parsedWeight = weight === null ? null : canonicalU32(weight, 100)
  return parsedSubject && parsedWeight !== null
    ? [parsedSubject, parsedWeight]
    : null
}

const validPatchTag = (tag: string[]): boolean => {
  const [name] = tag
  if (name === 'a') return tag.length === 2 && repoCoordinate(tag[1]) !== null
  if (name === 'p') return tag.length === 2 && hex32(tag[1]) !== null
  if (name === 't') return tag.length === 2
  if (name === 'r')
    return (
      (tag.length === 2 || (tag.length === 3 && tag[2] === 'euc')) &&
      isCommit(tag[1])
    )
  if (name === 'commit' || name === 'parent-commit')
    return tag.length === 2 && isCommit(tag[1])
  if (name === 'commit-pgp-sig') return tag.length === 2
  if (name === 'committer') return tag.length === 5
  return false
}

const validPrTag = (tag: string[]): boolean => {
  const [name] = tag
  if (name === 'a') return tag.length === 2 && repoCoordinate(tag[1]) !== null
  if (name === 'p') return tag.length === 2 && hex32(tag[1]) !== null
  if (name === 'r' || name === 'c' || name === 'merge-base')
    return tag.length === 2 && isCommit(tag[1])
  if (name === 'subject')
    return tag.length === 2 && tag[1].length > 0 && utf8Length(tag[1]) <= 256
  if (name === 't') return tag.length === 2
  if (name === 'h') return tag.length === 2 && canonicalUuid(tag[1])
  if (name === 'clone') return tag.length >= 2 && tag.slice(1).every(Boolean)
  if (name === 'branch-name') return tag.length === 2
  if (name === 'e') return tag.length === 2 && hex32(tag[1]) !== null
  return false
}

const validRepoRoot = (e: AuthenticatedEvent): boolean => {
  const coordinate = exactTwo(e, 'a')
  const owner = coordinate ? repoCoordinate(coordinate) : null
  if (!owner) return false
  const pTags = tagsNamed(e, 'p')
  if (!pTags.every((tag) => tag.length === 2 && hex32(tag[1]) !== null))
    return false
  if (!pTags.some((tag) => tag[1] === strip0x(owner))) return false
  if (e.kind === 1617) {
    const t = tagsNamed(e, 't')
    return (
      e.content.trim().length > 0 &&
      utf8Length(e.content) <= 60 * 1024 &&
      t.length === 1 &&
      t[0].length === 2 &&
      t[0][1] === 'root' &&
      tagsNamed(e, 'e').length === 0 &&
      e.tags.every(validPatchTag)
    )
  }
  if (e.kind !== 1618) return false
  const subject = exactTwo(e, 'subject')
  const commit = exactTwo(e, 'c')
  const clone = soleTag(e, 'clone')
  return (
    !!subject &&
    utf8Length(subject) <= 256 &&
    !!commit &&
    isCommit(commit) &&
    !!clone &&
    clone.length >= 2 &&
    clone.slice(1).every(Boolean) &&
    utf8Length(e.content) <= 64 * 1024 &&
    e.tags.every(validPrTag)
  )
}

const validStatus = (e: AuthenticatedEvent): Hex | null => {
  if (e.kind < 1630 || e.kind > 1633 || utf8Length(e.content) > 64 * 1024)
    return null
  const roots = tagsNamed(e, 'e').filter(
    (tag) =>
      tag.length === 4 && tag[2] === '' && tag[3] === 'root' && hex32(tag[1])
  )
  if (roots.length !== 1) return null
  if (tagsNamed(e, 'e').filter((tag) => tag[3] === 'reply').length > 1)
    return null
  if (
    tagsNamed(e, 'a').length > 1 ||
    tagsNamed(e, 'merge-commit').length > 1 ||
    tagsNamed(e, 'applied-as-commits').length > 1
  )
    return null
  const merged = e.kind === 1631
  for (const tag of e.tags) {
    const [name] = tag
    const valid =
      (name === 'e' &&
        tag.length === 4 &&
        tag[2] === '' &&
        (tag[3] === 'root' || tag[3] === 'reply') &&
        hex32(tag[1]) !== null) ||
      (name === 'p' && tag.length === 2 && hex32(tag[1]) !== null) ||
      (name === 'a' && tag.length === 2 && repoCoordinate(tag[1]) !== null) ||
      (name === 'r' && tag.length === 2 && isCommit(tag[1])) ||
      (merged &&
        name === 'q' &&
        tag.length >= 2 &&
        tag.length <= 4 &&
        hex32(tag[1]) !== null &&
        (tag.length < 4 || (tag[2].length > 0 && hex32(tag[3]) !== null))) ||
      (merged &&
        name === 'merge-commit' &&
        tag.length === 2 &&
        isCommit(tag[1])) ||
      (merged &&
        name === 'applied-as-commits' &&
        tag.length >= 2 &&
        tag.slice(1).every(isCommit))
    if (!valid) return null
  }
  const references = new Set(tagsNamed(e, 'r').map((tag) => tag[1]))
  const mergeCommit = exactTwo(e, 'merge-commit')
  if (mergeCommit && !references.has(mergeCommit)) return null
  const applied = soleTag(e, 'applied-as-commits')?.slice(1) ?? []
  if (
    new Set(applied).size !== applied.length ||
    applied.some((commit) => !references.has(commit))
  )
    return null
  return hex32(roots[0][1])
}

const eventOrder = (e: AuthenticatedEvent): [bigint, number, string] => [
  BigInt(e.order[0]),
  e.order[1],
  e.id.toLowerCase(),
]
const compareOrder = (a: AuthenticatedEvent, b: AuthenticatedEvent): number => {
  const x = eventOrder(a)
  const y = eventOrder(b)
  if (x[0] !== y[0]) return x[0] < y[0] ? -1 : 1
  if (x[1] !== y[1]) return x[1] - y[1]
  return x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0
}
const weighted = (
  base: bigint,
  provenance: 1 | 2,
  p: NostrWorkspaceParams
): bigint =>
  provenance === 1 ? (base * p.relayAttestedWeightFp) / p.precisionScale : base
const jointProvenance = (a: 1 | 2, b: 1 | 2): 1 | 2 => Math.min(a, b) as 1 | 2

interface Candidate {
  source: Hex
  target: Hex
  weight: bigint
  provenance: 1 | 2
  event: AuthenticatedEvent
}
const compareCandidate = (a: Candidate, b: Candidate): number =>
  a.provenance !== b.provenance
    ? a.provenance - b.provenance
    : compareOrder(a.event, b.event)

const validForumTarget = (e: AuthenticatedEvent): string | null => {
  if (e.kind !== 45001 && e.kind !== 45003) return null
  const channel = exactTwo(e, 'h')
  return channel && canonicalUuid(channel) ? channel : null
}
const validVote = (e: AuthenticatedEvent): [Hex, string, boolean] | null => {
  if (e.kind !== 45002 || e.tags.length !== 2) return null
  const channel = exactTwo(e, 'h')
  const target = exactTwo(e, 'e')
  if (!channel || !canonicalUuid(channel) || !target || !hex32(target))
    return null
  if (e.content !== '+' && e.content !== '-') return null
  return [hex32(target)!, channel, e.content === '+']
}
const validRequest = (e: AuthenticatedEvent): [Hex, string] | null => {
  if (
    e.kind !== 43001 ||
    e.tags.length !== 2 ||
    e.content.length === 0 ||
    utf8Length(e.content) > 16384
  )
    return null
  const channel = exactTwo(e, 'h')
  const agent = exactTwo(e, 'p')
  return channel && canonicalUuid(channel) && agent && hex32(agent)
    ? [hex32(agent)!, channel]
    : null
}
const terminalRefs = (e: AuthenticatedEvent): [Hex, Hex, string] | null => {
  const root = soleTag(e, 'e')
  const peer = exactTwo(e, 'p')
  const channel = exactTwo(e, 'h')
  if (
    !root ||
    root.length !== 4 ||
    root[2] !== '' ||
    root[3] !== 'root' ||
    !hex32(root[1]) ||
    !peer ||
    !hex32(peer) ||
    !channel ||
    !canonicalUuid(channel)
  )
    return null
  return [hex32(root[1])!, hex32(peer)!, channel]
}
const validTerminal = (
  e: AuthenticatedEvent,
  request: AuthenticatedEvent
): boolean => {
  const refs = terminalRefs(e)
  const req = validRequest(request)
  if (!refs || !req || refs[0] !== lower(request.id) || refs[2] !== req[1])
    return false
  const authCount = tagsNamed(e, 'auth').length
  if (e.kind === 43004)
    return (
      e.tags.length === 4 &&
      e.content.length > 0 &&
      utf8Length(e.content) <= 65536 &&
      lower(e.pubkey) === req[0] &&
      refs[1] === lower(request.pubkey) &&
      e.oaOwner !== null &&
      authCount === 1
    )
  if (e.kind === 43005)
    return (
      e.tags.length === 3 &&
      utf8Length(e.content) <= 4096 &&
      lower(e.pubkey) === lower(request.pubkey) &&
      refs[1] === req[0] &&
      authCount === 0
    )
  if (e.kind === 43006)
    return (
      e.tags.length === 4 &&
      utf8Length(e.content) <= 4096 &&
      lower(e.pubkey) === req[0] &&
      refs[1] === lower(request.pubkey) &&
      e.oaOwner !== null &&
      authCount === 1
    )
  return false
}

export const deriveSemantics = (
  events: AuthenticatedEvent[],
  rosterPubkeys: Hex[],
  p: NostrWorkspaceParams
): DerivedSemantics => {
  const accepted = events.filter((event) => event.disposition.accepted)
  const ownerSets = new Map<string, Set<string>>()
  for (const event of accepted) {
    if (!event.oaOwner) continue
    const owners = ownerSets.get(lower(event.pubkey)) ?? new Set<string>()
    owners.add(lower(event.oaOwner))
    ownerSets.set(lower(event.pubkey), owners)
  }
  const eligible = new Set<string>(rosterPubkeys.map(lower))
  const agents: Array<{ agent: Hex; owner: Hex }> = []
  for (const [agent, owners] of ownerSets) {
    if (owners.size !== 1) continue
    const owner = [...owners][0] as Hex
    eligible.add(agent)
    agents.push({ agent: agent as Hex, owner })
  }
  agents.sort((a, b) => cmpHex(a.agent, b.agent) || cmpHex(a.owner, b.owner))
  const usable = accepted.filter(
    (event) => !event.oaOwner || ownerSets.get(lower(event.pubkey))?.size === 1
  )
  const byId = new Map(usable.map((event) => [lower(event.id), event]))
  const outgoing = new Map<string, Map<string, bigint>>()
  const add = (source: Hex, target: Hex, weight: bigint) => {
    if (weight === 0n) return
    const sourceNode = nostrNodeId(source)
    const targetNode = nostrNodeId(target)
    const targets = outgoing.get(sourceNode) ?? new Map<string, bigint>()
    targets.set(targetNode, (targets.get(targetNode) ?? 0n) + weight)
    outgoing.set(sourceNode, targets)
  }

  for (const evidence of usable) {
    if (evidence.kind !== 36382) continue
    const vouch = validVouch(evidence)
    if (
      !vouch ||
      lower(evidence.pubkey) === vouch[0] ||
      !eligible.has(vouch[0])
    )
      continue
    add(
      lower(evidence.pubkey),
      vouch[0],
      weighted((p.wVouchFp * BigInt(vouch[1])) / 100n, evidence.provenance, p)
    )
  }

  const roots = new Set<string>()
  for (const evidence of usable)
    if (
      (evidence.kind === 1617 || evidence.kind === 1618) &&
      validRepoRoot(evidence)
    )
      roots.add(lower(evidence.id))
  const statuses = new Map<string, AuthenticatedEvent>()
  for (const evidence of usable) {
    const root = validStatus(evidence)
    if (!root) continue
    const key = `${lower(evidence.pubkey)}:${root}`
    const current = statuses.get(key)
    if (!current || compareOrder(evidence, current) > 0)
      statuses.set(key, evidence)
  }
  const mergePairs = new Map<string, Candidate>()
  for (const status of statuses.values()) {
    if (status.kind !== 1631) continue
    const rootId = validStatus(status)!
    const root = byId.get(rootId)
    if (
      !root ||
      !roots.has(rootId) ||
      lower(status.pubkey) === lower(root.pubkey)
    )
      continue
    const provenance = jointProvenance(status.provenance, root.provenance)
    const candidate: Candidate = {
      source: lower(status.pubkey),
      target: lower(root.pubkey),
      weight: weighted(p.wMergeFp, provenance, p),
      provenance,
      event: status,
    }
    const key = `${candidate.source}:${candidate.target}`
    const current = mergePairs.get(key)
    if (!current || compareCandidate(candidate, current) > 0)
      mergePairs.set(key, candidate)
  }
  for (const candidate of mergePairs.values())
    add(candidate.source, candidate.target, candidate.weight)

  const forumTargets = new Map<string, [AuthenticatedEvent, string]>()
  for (const evidence of usable) {
    const channel = validForumTarget(evidence)
    if (channel) forumTargets.set(lower(evidence.id), [evidence, channel])
  }
  const voteState = new Map<
    string,
    [AuthenticatedEvent, boolean, AuthenticatedEvent]
  >()
  for (const evidence of usable) {
    const vote = validVote(evidence)
    if (!vote) continue
    const target = forumTargets.get(vote[0])
    if (
      !target ||
      vote[1] !== target[1] ||
      lower(evidence.pubkey) === lower(target[0].pubkey)
    )
      continue
    const key = `${lower(evidence.pubkey)}:${vote[0]}`
    const current = voteState.get(key)
    if (!current || compareOrder(evidence, current[0]) > 0)
      voteState.set(key, [evidence, vote[2], target[0]])
  }
  const forumPairs = new Map<string, Candidate[]>()
  for (const [vote, positive, target] of voteState.values()) {
    if (!positive) continue
    const provenance = jointProvenance(vote.provenance, target.provenance)
    const candidate: Candidate = {
      source: lower(vote.pubkey),
      target: lower(target.pubkey),
      weight: weighted(p.wForumFp, provenance, p),
      provenance,
      event: vote,
    }
    const key = `${candidate.source}:${candidate.target}`
    const list = forumPairs.get(key) ?? []
    list.push(candidate)
    forumPairs.set(key, list)
  }

  const requests = new Map<string, AuthenticatedEvent>()
  for (const evidence of usable)
    if (validRequest(evidence)) requests.set(lower(evidence.id), evidence)
  const terminals = new Map<string, AuthenticatedEvent>()
  for (const evidence of usable) {
    if (evidence.kind < 43004 || evidence.kind > 43006) continue
    const refs = terminalRefs(evidence)
    const request = refs ? requests.get(refs[0]) : undefined
    if (!request || !validTerminal(evidence, request)) continue
    const current = terminals.get(refs![0])
    if (!current || compareOrder(evidence, current) > 0)
      terminals.set(refs![0], evidence)
  }
  const jobPairs = new Map<string, Candidate[]>()
  for (const [requestId, terminal] of terminals) {
    if (terminal.kind !== 43004) continue
    const request = requests.get(requestId)!
    const agent = lower(terminal.pubkey)
    if (
      lower(request.pubkey) === agent ||
      !eligible.has(agent) ||
      !terminal.oaOwner
    )
      continue
    const provenance = jointProvenance(request.provenance, terminal.provenance)
    const candidate: Candidate = {
      source: lower(request.pubkey),
      target: agent,
      weight: weighted(p.wJobFp, provenance, p),
      provenance,
      event: terminal,
    }
    const key = `${candidate.source}:${candidate.target}`
    const list = jobPairs.get(key) ?? []
    list.push(candidate)
    jobPairs.set(key, list)
  }

  const applyCapped = (pairs: Map<string, Candidate[]>, cap: number) => {
    for (const candidates of pairs.values()) {
      candidates.sort((a, b) => compareCandidate(b, a))
      for (const candidate of candidates.slice(0, cap))
        add(candidate.source, candidate.target, candidate.weight)
    }
  }
  applyCapped(forumPairs, p.forumPairCap)
  applyCapped(jobPairs, p.jobPairCap)

  const nodes = [...eligible]
    .map((pubkey) => nostrNodeId(pubkey as Hex))
    .sort(cmpHex)
  const edges = [...outgoing.entries()]
    .flatMap(([source, targets]) =>
      [...targets.entries()].map(([target, weightFp]) => ({
        source: source as Hex,
        target: target as Hex,
        weightFp,
      }))
    )
    .sort((a, b) => cmpHex(a.source, b.source) || cmpHex(a.target, b.target))
  return { graph: { nodes, outgoing }, edges, agents }
}

export const skipLeaf = (skip: SkippedNode): Hex =>
  keccak256(
    concat([
      skip.nodeId,
      wordU8(skip.reason),
      wordU64(BigInt(skip.epochObserved)),
    ])
  )
export const skippedDigest = (skips: SkippedNode[]): Hex => {
  const sorted = [...skips].sort((a, b) => {
    const byNode = cmpHex(a.nodeId, b.nodeId)
    if (byNode) return byNode
    if (a.reason !== b.reason) return a.reason - b.reason
    return BigInt(a.epochObserved) < BigInt(b.epochObserved) ? -1 : 1
  })
  let digest: Hex = ZERO_HASH
  for (const skip of sorted) digest = fold(digest, skipLeaf(skip))
  return digest
}

const rankParams = (p: NostrWorkspaceParams, seeds: Hex[]): RankParams => ({
  dampingFp: p.dampingFp,
  toleranceFp: p.toleranceFp,
  maxIterations: p.maxIterations,
  minWeightFp: 0n,
  maxWeightFp: 0n,
  trustMultiplierFp: p.trustMultiplierFp,
  trustShareFp: p.trustShareFp,
  trustDecayFp: p.trustDecayFp,
  trustedSeeds: seeds,
  totalPool: p.totalPool,
  precisionScale: p.precisionScale,
  schemaUid: ZERO_HASH,
  weightFieldIndex: 0,
  accumulator: `0x${'00'.repeat(20)}` as Hex,
  chainId: 0n,
})

export const recompute = (input: RecomputeInput) => {
  const semantics = deriveSemantics(
    input.events,
    input.rosterPubkeys,
    input.params
  )
  const seeds = input.params.trustedSeedPubkeys.map(nostrNodeId)
  const rank = rankParams(input.params, seeds)
  const scoresFp = calculate(semantics.graph, rank)
  const filtered = [...scoresFp.entries()].filter(
    ([, value]) => value !== 0n
  ) as Array<[Hex, bigint]>
  const { assigned, totalValue } = distributePoints(filtered, rank)
  assigned.sort((a, b) => cmpHex(a[0], b[0]))

  const bindingByNode = new Map(
    input.bindings.map((binding) => [lower(binding.nodeId), binding.address])
  )
  const leaves = assigned.map(([node, value]) => nodeOutputLeaf(node, value))
  for (const [node, value] of assigned) {
    const address = bindingByNode.get(lower(node))
    if (address) leaves.push(outputLeaf(address, value))
  }
  const outputRoot = merkleRoot(leaves)
  const blob = canonicalBlob(assigned)
  const digest = sha256Utf8(blob)
  const cid = cidV1Raw(digest)
  const journal: Journal = {
    acc: ZERO_HASH,
    leafCount: 0n,
    anchorAcc: input.anchorAcc,
    anchorCount: input.anchorCount,
    paramsHash: paramsHash(input.params),
    outputRoot,
    ipfsHash: digestToHex(digest),
    cidDigest: keccak256(stringToBytes(cid)),
    totalValue,
    skippedDigest: skippedDigest(input.skips),
    recipient: input.binding.recipient,
    instanceDomain: input.binding.instanceDomain,
  }
  return { semantics, scores: assigned, blob, cid, journal }
}

export const journalDigest = (journal: Journal): Hex =>
  encodeJournalDigest(journal)
