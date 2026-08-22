import { strict as assert } from 'node:assert'

import { type Hex } from 'viem'

import { hashPair, merkleRoot, outputLeaf } from './pagerank/merkle'
import { merkleEntriesForScores } from './pagerank/simulate'
import {
  ScoreboardExportInput,
  createScoreboardExportDocument,
  serializeScoreboardCSV,
  serializeScoreboardJSON,
} from './scoreboard-export'

const exportedAt = '2026-08-13T12:34:56.000Z'
const snapshot = `0x${'11'.repeat(20)}`
const root = `0x${'22'.repeat(32)}`
const proof = [`0x${'33'.repeat(32)}`, `0x${'44'.repeat(32)}`]

const simulatedProofEntries = merkleEntriesForScores([
  [`0x${'aa'.repeat(20)}` as Hex, 2n * 10n ** 18n],
  [`0x${'bb'.repeat(20)}` as Hex, 10n ** 18n],
])
const simulatedRoot = merkleRoot(
  simulatedProofEntries.map(({ account, value }) => outputLeaf(account, value))
)
for (const entry of simulatedProofEntries) {
  const provenRoot = entry.proof.reduce(
    (node, sibling) => hashPair(node, sibling),
    outputLeaf(entry.account, entry.value)
  )
  assert.equal(provenRoot, simulatedRoot)
}
assert.deepEqual(
  merkleEntriesForScores([[`0x${'cc'.repeat(20)}` as Hex, 1n]])[0].proof,
  []
)

const published: ScoreboardExportInput = {
  metadata: {
    mode: 'published',
    snapshot,
    root,
    ipfsHashCid: 'bafy-published',
    scoresAsOf: { blockNumber: '12345', timestamp: '1786640000' },
    liveCountsFetchedAt: '2026-08-13T12:33:00.000Z',
  },
  data: [
    {
      account: `0x${'aa'.repeat(20)}`,
      value: '1234567890123456789',
      proof,
      received: 7,
      sent: 3,
    },
  ],
}

const document = createScoreboardExportDocument(published, exportedAt)
assert.equal(document.mode, 'published')
assert.equal(document.snapshot, snapshot)
assert.equal(document.merkleRoot, root)
assert.equal(document.scoresAsOf?.blockNumber, '12345')
assert.equal(document.liveAttestationCounts.committedToMerkleRoot, false)
assert.equal(document.network[0].score, '1.234567890123456789')
assert.equal(document.network[0].scoreRaw, '1234567890123456789')
assert.deepEqual(document.network[0].proof, proof)

const json = JSON.parse(serializeScoreboardJSON(published, exportedAt))
assert.equal(json.exportDate, exportedAt)
assert.deepEqual(json.network[0].proof, proof)
assert.equal(json.network[0].receivedLive, 7)

const csv = serializeScoreboardCSV(published, exportedAt)
const [csvHeader, csvRow] = csv.split('\n')
assert.match(csvHeader, /"Received \(Live, Not In Root\)"/)
assert.match(csvHeader, /"Score Raw"/)
assert.match(csvHeader, /"Merkle Proof"/)
assert.match(csvRow, new RegExp(snapshot))
assert.match(csvRow, new RegExp(root))
assert.match(csvRow, /"1\.234567890123456789"/)
assert.match(csvRow, /"1234567890123456789"/)
// The proof remains a JSON array inside one correctly escaped CSV cell.
assert.match(csvRow, /"\[""0x33/)

const simulation: ScoreboardExportInput = {
  data: published.data,
  metadata: {
    mode: 'simulation',
    snapshot,
    root: `0x${'55'.repeat(32)}`,
    ipfsHashCid: 'bafy-simulation',
    liveCountsFetchedAt: '2026-08-13T12:33:00.000Z',
    simulation: {
      kind: 'reduced-lane-1-browser-recompute',
      inputDataFetchedAt: '2026-08-13T12:33:00.000Z',
      referencePublishedRoot: root,
      referencePublishedRootAsOf: {
        blockNumber: '12345',
        timestamp: '1786640000',
      },
      params: {
        dampingFactor: 0.85,
        trustMultiplier: 3,
        trustShare: 1,
        trustDecay: 0.8,
        maxIterations: 100,
        minWeight: 0,
        maxWeight: 100,
        trustedSeeds: [`0x${'aa'.repeat(20)}`],
        pointsPool: '1000000000000000000000000',
        precisionScale: '1000000000000000000',
        accumulator: `0x${'66'.repeat(20)}`,
        chainId: '1',
      },
      paramsHash: `0x${'77'.repeat(32)}`,
      inputAccumulator: `0x${'88'.repeat(32)}`,
      inputLeafCount: '9',
    },
  },
}

const simulatedDocument = createScoreboardExportDocument(simulation, exportedAt)
assert.equal(simulatedDocument.mode, 'simulation')
assert.equal(simulatedDocument.rootStatus, 'local-simulation-not-published')
assert.equal(simulatedDocument.scoresAsOf, null)
assert.equal(simulatedDocument.simulation?.referencePublishedRoot, root)
assert.equal(
  simulatedDocument.simulation?.paramsHash,
  simulation.metadata.mode === 'simulation'
    ? simulation.metadata.simulation.paramsHash
    : ''
)

const simulatedCsv = serializeScoreboardCSV(simulation, exportedAt)
assert.match(simulatedCsv, /"simulation"/)
assert.match(simulatedCsv, /"local-simulation-not-published"/)
assert.match(simulatedCsv, /0x77777777/)
assert.match(simulatedCsv, /reduced-lane-1-browser-recompute/)
assert.match(simulatedCsv, /dampingFactor/)

console.log('scoreboard export serialization and simulation provenance: ok')
