#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { type Hex } from 'viem'

import {
  type NostrIndexerSidecar,
  validateNostrScoreCommitment,
  validateNostrWorkspaceSidecar,
} from '../src/nostr-workspace-shared'
import { requireScoreProgram, validateScoreBlob } from '../src/score-program'

const { values } = parseArgs({
  options: {
    blob: { type: 'string' },
    journal: { type: 'string' },
    sidecar: { type: 'string' },
    cid: { type: 'string' },
    program: { type: 'string' },
    'output-domain': { type: 'string' },
  },
})

const required = (name: keyof typeof values) => {
  const value = values[name]
  if (!value) throw new Error(`--${name} is required`)
  return value
}

const blobPath = required('blob')
const journalPath = required('journal')
const sidecarPath = required('sidecar')
const cid = required('cid')
const programId = required('program') as Hex
const outputDomain = required('output-domain') as Hex

const outputBytes = new Uint8Array(readFileSync(blobPath))
const rawScores = JSON.parse(
  new TextDecoder('utf-8', { fatal: true }).decode(outputBytes)
) as Record<string, unknown>
const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
  output_root: Hex
  ipfs_hash: Hex
  total_value: string
  skipped_digest: Hex
}
const sidecar = JSON.parse(
  readFileSync(sidecarPath, 'utf8')
) as NostrIndexerSidecar

const program = requireScoreProgram(programId, outputDomain)
if (program.ingestion !== 'nostr-workspace') {
  throw new Error(
    `authenticated program route selected ${program.ingestion}, not nostr-workspace`
  )
}
const scores = validateScoreBlob(rawScores, program) as Record<string, string>
validateNostrScoreCommitment(
  scores,
  outputBytes,
  journal.ipfs_hash,
  cid,
  BigInt(journal.total_value)
)
const indexed = validateNostrWorkspaceSidecar(
  scores,
  sidecar,
  journal.output_root,
  journal.skipped_digest
)

console.log(
  JSON.stringify({
    program: program.name,
    outputDomain: program.outputDomainName,
    root: indexed.tree[0],
    scores: indexed.rows.length,
    agents: indexed.rows.filter((row) => row.actorKind === 'agent').length,
    bindings: indexed.rows.filter((row) => row.boundAddress !== null).length,
    skipSummary: indexed.skipSummary,
  })
)
