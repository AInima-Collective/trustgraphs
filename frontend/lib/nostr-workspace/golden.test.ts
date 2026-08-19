import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import './api.test'

import { type Hex, keccak256, stringToBytes } from 'viem'

import {
  type AuthenticatedEvent,
  type NostrWorkspaceParams,
  journalDigest,
  paramsEncoded,
  paramsHash,
  recompute,
  seedSetRoot,
} from './recompute'

const golden = JSON.parse(
  readFileSync('../test/golden/nostr-workspace.json', 'utf8')
)
const p = golden.params

const params: NostrWorkspaceParams = {
  version: Number(p.version),
  outputDomain: p.outputDomain as Hex,
  dampingFp: BigInt(p.dampingFp),
  toleranceFp: BigInt(p.toleranceFp),
  maxIterations: Number(p.maxIterations),
  trustMultiplierFp: BigInt(p.trustMultiplierFp),
  trustShareFp: BigInt(p.trustShareFp),
  trustDecayFp: BigInt(p.trustDecayFp),
  precisionScale: BigInt(p.precisionScale),
  totalPool: BigInt(p.totalPool),
  trustedSeedPubkeys: p.trustedSeedPubkeys as Hex[],
  communityId: p.communityId as Hex,
  instanceDomain: p.instanceDomain as Hex,
  relayPubkey: p.relayPubkey as Hex,
  chainId: BigInt(p.chainId),
  allowedVariants: Number(p.allowedVariants),
  wVouchFp: BigInt(p.wVouchFp),
  wMergeFp: BigInt(p.wMergeFp),
  wJobFp: BigInt(p.wJobFp),
  wForumFp: BigInt(p.wForumFp),
  relayAttestedWeightFp: BigInt(p.relayAttestedWeightFp),
  forumPairCap: Number(p.forumPairCap),
  jobPairCap: Number(p.jobPairCap),
  lane2MaxHeadAge: BigInt(p.lane2MaxHeadAge),
  maxAnchorRecords: Number(p.maxAnchorRecords),
  maxEstimatedPgu: BigInt(p.maxEstimatedPgu),
  limits: {
    envelopeBytes: Number(p.limits.envelopeBytes),
    selectedHeads: Number(p.limits.selectedHeads),
    auditEntries: Number(p.limits.auditEntries),
    events: Number(p.limits.events),
    encodedEventBytes: Number(p.limits.encodedEventBytes),
    contentBytes: Number(p.limits.contentBytes),
    tagsPerEvent: Number(p.limits.tagsPerEvent),
    elementsPerTag: Number(p.limits.elementsPerTag),
    tagStringBytes: Number(p.limits.tagStringBytes),
    allTagStringsBytes: Number(p.limits.allTagStringsBytes),
    auditDetailBytes: Number(p.limits.auditDetailBytes),
    nip01Signatures: Number(p.limits.nip01Signatures),
    oaSignatures: Number(p.limits.oaSignatures),
  },
}

console.log('golden-vector reproduction (nostr-workspace TS reduced tier)')

assert.equal(
  keccak256(stringToBytes('nostr-workspace')).toLowerCase(),
  String(golden.programId).toLowerCase()
)
assert.equal(
  keccak256(stringToBytes('trustgraphs.output.nostr-member.v1')).toLowerCase(),
  String(golden.outputDomain).toLowerCase()
)
assert.equal(
  seedSetRoot(params.trustedSeedPubkeys).toLowerCase(),
  String(p.seedSetRoot).toLowerCase()
)
assert.equal(
  paramsEncoded(params).toLowerCase(),
  String(p.encoded).toLowerCase()
)
assert.equal(
  paramsHash(params).toLowerCase(),
  String(golden.paramsHash).toLowerCase()
)

const result = recompute({
  events: golden.recompute.events as AuthenticatedEvent[],
  rosterPubkeys: golden.metadata.rosterPubkeys as Hex[],
  bindings: golden.metadata.bindings as Array<{ nodeId: Hex; address: Hex }>,
  skips: golden.skipped.entries as Array<{
    nodeId: Hex
    reason: number
    epochObserved: string
  }>,
  params,
  anchorAcc: golden.journal.anchorAcc as Hex,
  anchorCount: BigInt(golden.journal.anchorCount),
  binding: {
    recipient: golden.journal.recipient as Hex,
    instanceDomain: golden.journal.instanceDomain as Hex,
  },
})

const actualEdges = result.semantics.edges.map((edge) => ({
  source: edge.source,
  target: edge.target,
  weightFp: edge.weightFp.toString(),
}))
assert.deepEqual(actualEdges, golden.recompute.edges)
assert.deepEqual(
  result.semantics.agents.map((agent) => ({
    agentPubkey: agent.agent,
    ownerPubkey: agent.owner,
  })),
  golden.metadata.agents.map(
    (agent: { agentPubkey: Hex; ownerPubkey: Hex }) => ({
      agentPubkey: agent.agentPubkey,
      ownerPubkey: agent.ownerPubkey,
    })
  )
)
assert.equal(result.journal.outputRoot, golden.journal.outputRoot)
assert.equal(result.journal.paramsHash, golden.journal.paramsHash)
assert.equal(result.journal.ipfsHash, golden.journal.ipfsHash)
assert.equal(result.journal.cidDigest, golden.journal.cidDigest)
assert.equal(result.journal.totalValue.toString(), golden.journal.totalValue)
assert.equal(result.journal.skippedDigest, golden.journal.skippedDigest)
assert.equal(result.blob, golden.cid.blob)
assert.equal(result.cid, golden.cid.cid)
assert.equal(journalDigest(result.journal), golden.journal.digest)

console.log('All nostr-workspace golden vectors reproduced. PASS')
