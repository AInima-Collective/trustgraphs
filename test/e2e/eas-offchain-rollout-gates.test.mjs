import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const checker = resolve(root, 'scripts/eas-offchain-soak-check.mjs')
const example = resolve(
  root,
  'docs/build/eas-offchain/rollout-evidence.example.json'
)
const instanceId = `0x${'11'.repeat(32)}`
const cid = 'bafkreiaghkksmbqe3wdicjuiv3azpgxlqdsz6mv7dq5gisxvuahthol5ki'
const startMs = Date.parse('2026-07-01T00:00:00Z')
const endMs = Date.parse('2026-07-15T00:00:00Z')
const iso = (value) => new Date(value).toISOString()
const hex32 = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const evidence = (label) =>
  `sha256:${createHash('sha256').update(label).digest('hex')}`

const validTopology = () => ({
  relays: ['relay-a', 'relay-b'].map((id) => ({
    id,
    evidence: evidence(`topology-${id}`),
  })),
  storageTargets: [
    ['relay-a-store-a', 'relay-a'],
    ['relay-a-store-b', 'relay-a'],
    ['relay-b-store-a', 'relay-b'],
    ['relay-b-store-b', 'relay-b'],
  ].map(([id, relayId]) => ({
    id,
    relayId,
    evidence: evidence(`topology-${id}`),
  })),
  readers: ['reader-a', 'reader-b'].map((id) => ({
    id,
    evidence: evidence(`topology-${id}`),
  })),
  primaryRpc: {
    id: 'primary-rpc',
    evidence: evidence('topology-primary-rpc'),
  },
  indexer: { id: 'indexer', evidence: evidence('topology-indexer') },
  prover: { id: 'prover', evidence: evidence('topology-prover') },
})

const drillNames = (topology) => [
  ...topology.relays.map((entry) => `relay-loss:${entry.id}`),
  ...topology.storageTargets.map((entry) => `storage-loss:${entry.id}`),
  ...topology.readers.map((entry) => `reader-loss:${entry.id}`),
  `rpc-loss:${topology.primaryRpc.id}`,
  `indexer-loss:${topology.indexer.id}`,
  `prover-loss:${topology.prover.id}`,
  'all-readers-loss',
  'corrupt-reader-recovery',
  'conflict-recovery',
  'repin-recovery',
  'backup-restore',
  'relayer-key-rotation',
]

const drillAssertions = (name) => ({
  ...(name.startsWith('relay-loss:') ? { alternateRelaySucceeded: true } : {}),
  ...(name.startsWith('storage-loss:') ? { quorumPolicyEnforced: true } : {}),
  ...(name.startsWith('reader-loss:') ? { remainingReadersExact: true } : {}),
  ...(name.startsWith('rpc-loss:') ? { failoverRpcUsed: true } : {}),
  ...(name.startsWith('indexer-loss:') ? { replayedFromChain: true } : {}),
  ...(name.startsWith('prover-loss:') ? { byteIdenticalRetry: true } : {}),
  ...(name === 'all-readers-loss'
    ? { proofHeld: true, proofRequested: false, proofSubmitted: false }
    : {}),
  ...(name === 'corrupt-reader-recovery'
    ? {
        corruptionRejected: true,
        healthyReaderFallback: true,
        corruptCopyQuarantined: true,
      }
    : {}),
  ...(name === 'conflict-recovery'
    ? {
        canonicalHeadReloaded: true,
        unsignedDraftReapplied: true,
        forkAnchorPrevented: true,
      }
    : {}),
  ...(name === 'repin-recovery'
    ? { cidRecomputed: true, byteExactReadback: true }
    : {}),
  ...(name === 'backup-restore'
    ? {
        freshRepository: true,
        allCidsRecomputed: true,
        historicalCheckpointReproduced: true,
      }
    : {}),
  ...(name === 'relayer-key-rotation'
    ? { oldRoleRevoked: true, twoDistinctRelayersRetained: true }
    : {}),
})

const validReport = () => {
  const topology = validTopology()
  const drills = drillNames(topology)
  return {
    schemaVersion: 3,
    instanceId,
    mainnetEnabled: false,
    topology,
    soak: { startedAt: iso(startMs), endedAt: iso(endMs) },
    evidence: {
      darkDeploy: evidence('dark'),
      internalCanary: evidence('canary'),
      optInCohort: evidence('cohort'),
      realGroth16: evidence('real-proof'),
    },
    checkpoints: Array.from({ length: 20 }, (_, index) => {
      const lane1Leaves = index + 1
      const lane2Anchors = index + 1
      const lane2Work = lane2Anchors * 5
      return {
        checkpointId: String(index),
        instanceId,
        observedAt: iso(startMs + ((endMs - startMs) * index) / 19),
        verifiedOnchain: true,
        transactionHash: hex32(index + 1),
        outputRoot: hex32(index + 101),
        cid,
        evidence: evidence(`checkpoint-${index}`),
        proofBackend: index === 0 ? 'sp1-network-groth16' : 'sp1-local-groth16',
        cycles: 1_000_000 + index,
        proofSeconds: 30 + index,
        anchorGas: 90_000 + index,
        submissionGas: 300_000 + index,
        bundleBytes: 800 + index,
        lane1Leaves,
        lane2Anchors,
        lane2Work,
        workCount: lane1Leaves + lane2Work,
      }
    }),
    drills: Object.fromEntries(
      drills.map((name, index) => [
        name,
        {
          status: 'passed',
          observedAt: iso(
            startMs + ((endMs - startMs) * (index + 1)) / (drills.length + 1)
          ),
          evidence: evidence(`drill-${name}`),
          alertDelivered: true,
          proofSafetyPreserved: true,
          recovered: true,
          postRecoveryCheckpointId: '19',
          ...drillAssertions(name),
        },
      ])
    ),
    measurementBands: [
      { band: 1, workCount: 1_000 },
      { band: 2, workCount: 20_000 },
      { band: 3, workCount: 200_000 },
    ].map((measurement) => ({
      ...measurement,
      sampleCount: 3,
      observedAt: iso(startMs + measurement.band * 86_400_000),
      cycles: measurement.band * 1_000_000,
      proofSeconds: measurement.band * 30,
      proofCostUsd: measurement.band * 0.25,
      bundleBytes: measurement.band * 800,
      anchorGas: measurement.band * 90_000,
      submissionGas: measurement.band * 300_000,
      failureRateBps: 0,
      capUtilizationBps: measurement.band * 1_000,
      evidence: evidence(`band-${measurement.band}`),
    })),
    outcomes: {
      unexplainedRootMismatches: 0,
      lostAnchoredBundles: 0,
      unresolvedIncidents: 0,
    },
    securityReview: {
      reviewer: 'Independent Security LLC',
      report: evidence('security-review'),
      unresolvedCritical: 0,
      unresolvedHigh: 0,
      mediumFindings: [
        {
          status: 'fixed',
          evidence: evidence('medium-1-fix'),
        },
      ],
    },
  }
}

const run = (report) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'eas-rollout-gate-'))
  const path = resolve(directory, `${randomUUID()}.json`)
  try {
    writeFileSync(path, JSON.stringify(report))
    return spawnSync(process.execPath, [checker, path], {
      cwd: root,
      encoding: 'utf8',
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const rejects = (mutate, expected) => {
  const report = structuredClone(validReport())
  mutate(report)
  const result = run(report)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, expected)
}

test('soak evidence contract accepts a complete, past, mixed-lane ledger', () => {
  const result = run(validReport())
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /PASS \(20 checkpoints, 14 days\)/)
})

test('published rollout template is deliberately non-passing', () => {
  const result = run(JSON.parse(readFileSync(example, 'utf8')))
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /at least 20 checkpoint records are required/)
})

test('soak evidence rejects a non-object JSON document cleanly', () => {
  const result = run(null)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /rollout evidence must be a JSON object/)
})

test('soak evidence rejects future windows and observations outside the window', () => {
  rejects((report) => {
    report.soak.startedAt = '2099-01-01T00:00:00Z'
    report.soak.endedAt = '2099-01-15T00:00:00Z'
  }, /soak\.endedAt cannot be in the future/)
  rejects((report) => {
    report.drills['relay-loss:relay-a'].observedAt = '2026-06-30T23:59:59Z'
  }, /drill relay-loss:relay-a is outside the soak window/)
})

test('soak evidence rejects replayed transactions and non-monotonic checkpoint ledgers', () => {
  rejects((report) => {
    report.checkpoints[1].transactionHash =
      report.checkpoints[0].transactionHash
  }, /transactionHash duplicates an earlier checkpoint/)
  rejects((report) => {
    report.checkpoints[2].checkpointId = '1'
  }, /checkpointId duplicates 1/)
})

test('real network proof must be mixed-lane with exact published work accounting', () => {
  rejects((report) => {
    report.checkpoints[0].lane1Leaves = 0
    report.checkpoints[0].workCount = report.checkpoints[0].lane2Work
  }, /real network proof must be mixed-lane/)
  rejects((report) => {
    report.checkpoints[3].workCount += 1
  }, /workCount must equal lane1Leaves \+ lane2Work/)
})

test('chaos coverage follows every declared dependency and proves safe recovery', () => {
  rejects((report) => {
    report.topology.storageTargets.push({
      id: 'relay-a-store-c',
      relayId: 'relay-a',
      evidence: evidence('topology-relay-a-store-c'),
    })
  }, /drill storage-loss:relay-a-store-c has not passed/)
  rejects((report) => {
    report.topology.storageTargets[0].relayId = 'missing-relay'
  }, /relayId does not name a deployed relay/)
  rejects((report) => {
    report.drills['all-readers-loss'].proofSubmitted = true
  }, /all-readers-loss must record proofSubmitted=false/)
  rejects((report) => {
    report.drills['relay-loss:relay-a'].postRecoveryCheckpointId = '999'
  }, /postRecoveryCheckpointId is not in the soak ledger/)
  rejects((report) => {
    report.drills['relay-loss:relay-a'].observedAt =
      report.checkpoints[19].observedAt
  }, /recovery checkpoint must follow the drill/)
  rejects((report) => {
    report.drills['corrupt-reader-recovery'].corruptionRejected = false
  }, /corrupt-reader-recovery must record corruptionRejected=true/)
  rejects((report) => {
    report.drills['backup-restore'].freshRepository = false
  }, /backup-restore must record freshRepository=true/)
  rejects((report) => {
    report.drills['relayer-key-rotation'].oldRoleRevoked = false
  }, /relayer-key-rotation must record oldRoleRevoked=true/)
})

test('measurements and evidence references fail closed', () => {
  rejects((report) => {
    report.schemaVersion = 2
  }, /schemaVersion must be 3/)
  rejects((report) => {
    report.instanceId = 1
  }, /instanceId must be a bytes32 value/)
  rejects((report) => {
    report.measurementBands[1].workCount = 1_000
  }, /measurement band 2\.workCount is outside its published range/)
  rejects((report) => {
    report.evidence.darkDeploy = 'https://mutable.example/report/latest'
  }, /evidence\.darkDeploy requires an immutable content digest/)
  rejects((report) => {
    report.checkpoints[0].evidence = 'https://mutable.example/checkpoint/latest'
  }, /checkpoints\[0\]\.evidence requires an immutable content digest/)
})
