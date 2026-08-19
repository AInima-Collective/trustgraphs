import assert from 'node:assert/strict'
import test from 'node:test'

import { type Hex, concat, keccak256 } from 'viem'

import { SCORE_OUTPUT_DOMAIN_IDS, SCORE_PROGRAM_IDS } from '../score-program'
import { nostrNodeId, parseNostrWorkspaceScorePage } from './api'
import { nodeOutputLeaf } from './recompute'

const pubkey = `0x${'11'.repeat(32)}` as Hex
const nodeId = nostrNodeId(pubkey)
const value = '7'
const root = nodeOutputLeaf(nodeId, 7n)
const response = {
  snapshot: `0x${'22'.repeat(20)}`,
  root,
  checkpointId: '1',
  ipfsHash: keccak256(concat(['0x01'])),
  ipfsHashCid: 'bafkreifixture',
  numNodes: 1,
  totalValue: value,
  skippedDigest: `0x${'00'.repeat(32)}`,
  anchorAcc: `0x${'55'.repeat(32)}`,
  anchorCount: '2',
  accessPolicy: 'member-scoped',
  epochTrustClass: 'relay-exporter-attested+member-self-committed',
  reducedRecomputeStatus: 'production-core-and-output-root-reproduced',
  skipSummary: { '9': 1 },
  archiveProvenance: {
    selectedCommitments: [`0x${'66'.repeat(32)}`],
    archives: [{ cid: 'redacted://member-archive' }],
  },
  blockNumber: '100',
  timestamp: '200',
  scoreProgram: {
    programId: SCORE_PROGRAM_IDS['nostr-workspace'],
    programName: 'nostr-workspace',
    outputDomain: SCORE_OUTPUT_DOMAIN_IDS['nostr-member-v1'],
    outputDomainName: 'nostr-member-v1',
    keyEncoding: 'bytes32',
    instanceId: `0x${'77'.repeat(32)}`,
    verifier: `0x${'88'.repeat(20)}`,
    registryOrAccumulator: `0x${'99'.repeat(20)}`,
    paramsHash: `0x${'aa'.repeat(32)}`,
    source: {
      kind: 'instance-registered',
      registry: `0x${'33'.repeat(20)}`,
      blockNumber: '10',
      logIndex: 2,
      transactionHash: `0x${'44'.repeat(32)}`,
    },
  },
  scores: [
    {
      nodeId,
      nostrPubkey: pubkey,
      actorKind: 'member',
      ownerNodeId: null,
      boundAddress: null,
      value,
      proof: [],
    },
  ],
  page: { limit: 50, offset: 0, total: 1 },
}

test('typed Nostr response accepts authenticated provenance and verifies each proof', () => {
  const parsed = parseNostrWorkspaceScorePage(response)
  assert.equal(parsed.scoreProgram.programName, 'nostr-workspace')
  assert.equal(parsed.scores[0]?.nodeId, nodeId)
})

test('typed Nostr response rejects domain confusion, false owner provenance, and content leakage', () => {
  assert.throws(
    () =>
      parseNostrWorkspaceScorePage({
        ...response,
        scoreProgram: {
          ...response.scoreProgram,
          outputDomain: SCORE_OUTPUT_DOMAIN_IDS['hypercerts-node-v1'],
        },
      }),
    /program\/output domain mismatch/
  )
  assert.throws(
    () =>
      parseNostrWorkspaceScorePage({
        ...response,
        scores: [{ ...response.scores[0], ownerNodeId: nodeId }],
      }),
    /owner provenance/
  )
  assert.throws(
    () =>
      parseNostrWorkspaceScorePage({
        ...response,
        archiveProvenance: { eventContent: 'scoped text' },
      }),
    /forbidden field/
  )
  assert.throws(
    () =>
      parseNostrWorkspaceScorePage({
        ...response,
        root: `0x${'ff'.repeat(32)}`,
      }),
    /proof does not reproduce/
  )
})
