import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { type Address, type Hex, sha256, stringToBytes } from 'viem'

import {
  type NostrIndexerSidecar,
  nostrEpochTrustClass,
  nostrNodeId,
  validateNostrScoreCommitment,
  validateNostrWorkspaceSidecar,
} from './nostr-workspace-shared.ts'

const node = `0x${'11'.repeat(32)}`
const blob = `{"${node}":"7"}`
const bytes = stringToBytes(blob)
const digest = sha256(bytes)
const cid = 'bafkreiaqzffggmpodpe72ouxdudcrtrilbjsvhbpi6exnsrsmqxd7rw5xm'

test('Nostr ingestion binds canonical bytes, digest, CID, and total', () => {
  validateNostrScoreCommitment({ [node]: '7' }, bytes, digest, cid, 7n)
  assert.throws(
    () =>
      validateNostrScoreCommitment(
        { [node]: '7' },
        stringToBytes(`${blob}\n`),
        digest,
        cid,
        7n
      ),
    /canonical committed encoding/
  )
  assert.throws(
    () =>
      validateNostrScoreCommitment(
        { [node]: '7' },
        bytes,
        `0x${'ff'.repeat(32)}` as Hex,
        cid,
        7n
      ),
    /ipfsHash/
  )
  assert.throws(
    () =>
      validateNostrScoreCommitment(
        { [node]: '7' },
        bytes,
        digest,
        `${cid}x`,
        7n
      ),
    /CID/
  )
  assert.throws(
    () => validateNostrScoreCommitment({ [node]: '7' }, bytes, digest, cid, 8n),
    /totalValue/
  )
})

test('Nostr ingestion accepts exact Rust archive variant spelling and rejects aliases', () => {
  assert.equal(nostrEpochTrustClass(['BuzzAuditV1']), 'relay-exporter-attested')
  assert.equal(
    nostrEpochTrustClass(['BuzzAuditV1', 'SelfLogV1']),
    'relay-exporter-attested+member-self-committed'
  )
  for (const invalid of ['buzz-audit-v1', 'self-log-v1', 'SidecarHeadV1']) {
    assert.throws(
      () => nostrEpochTrustClass([invalid]),
      /unsupported commitment variant/
    )
  }
  assert.throws(() => nostrEpochTrustClass([]), /selected no archives/)
})

test('frozen Nostr artifact reproduces its committed CID, total, and output root', () => {
  const golden = JSON.parse(
    readFileSync(
      new URL('../../test/golden/nostr-workspace.json', import.meta.url),
      'utf8'
    )
  ) as {
    cid: { blob: string; blobHex: Hex; cid: string }
    journal: { ipfsHash: Hex; outputRoot: Hex; totalValue: string }
    metadata: {
      rosterPubkeys: Hex[]
      agents: NostrIndexerSidecar['agents']
      bindings: { nodeId: Hex; address: Address }[]
    }
    skipped: {
      digest: Hex
      entries: { nodeId: Hex; reason: number; epochObserved: string }[]
    }
  }
  const scores = JSON.parse(golden.cid.blob) as Record<string, string>
  const outputBytes = stringToBytes(golden.cid.blob)
  assert.equal(
    `0x${Buffer.from(outputBytes).toString('hex')}`,
    golden.cid.blobHex,
    'the human-readable blob and frozen byte vector must agree'
  )
  validateNostrScoreCommitment(
    scores,
    outputBytes,
    golden.journal.ipfsHash,
    golden.cid.cid,
    BigInt(golden.journal.totalValue)
  )

  const sidecar: NostrIndexerSidecar = {
    format: 'trustgraphs.nostr.indexer-sidecar.v1',
    roster: golden.metadata.rosterPubkeys.map((pubkey) => ({
      pubkey,
      nodeId: nostrNodeId(pubkey),
    })),
    agents: golden.metadata.agents,
    bindings: Object.fromEntries(
      golden.metadata.bindings.map(({ nodeId, address }) => [nodeId, address])
    ),
    skips: golden.skipped.entries.map((skip) => ({
      node_id: skip.nodeId,
      reason: skip.reason,
      epoch_observed: skip.epochObserved,
    })),
  }
  const indexed = validateNostrWorkspaceSidecar(
    scores,
    sidecar,
    golden.journal.outputRoot,
    golden.skipped.digest
  )
  assert.equal(indexed.tree[0], golden.journal.outputRoot)
  assert.equal(indexed.rows.length, 3)
  assert.equal(
    indexed.rows.filter((row) => row.actorKind === 'agent').length,
    1
  )
  assert.equal(indexed.rows.filter((row) => row.boundAddress).length, 1)

  const wrongOwner = structuredClone(sidecar)
  wrongOwner.agents[0]!.ownerNodeId = wrongOwner.agents[0]!.agentNodeId
  assert.throws(
    () =>
      validateNostrWorkspaceSidecar(
        scores,
        wrongOwner,
        golden.journal.outputRoot,
        golden.skipped.digest
      ),
    /agent\/owner provenance/
  )
})
