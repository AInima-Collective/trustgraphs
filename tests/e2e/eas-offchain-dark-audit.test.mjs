import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const audit = resolve(root, 'scripts/eas-offchain-testnet-audit.sh')
const hex = (byte, length) => `0x${byte.repeat(length)}`
const addresses = {
  directory: hex('01', 20),
  admin: hex('02', 20),
  relayerA: hex('03', 20),
  relayerB: hex('04', 20),
  snapshot: hex('05', 20),
  accumulator: hex('06', 20),
  registry: hex('07', 20),
  factory: hex('08', 20),
  eas: hex('09', 20),
  verifier: hex('0a', 20),
  gateway: hex('0b', 20),
}
const instanceId = hex('11', 32)
const schemaUid = hex('12', 32)
const easDomain = hex('13', 32)
const headDomain = hex('14', 32)
const programVKey = hex('15', 32)
const anchorerRole = hex('aa', 32)
const zeroRole = hex('00', 32)
const chainId = '11155111'
const cap = '200000'
const evidence = (label) =>
  `sha256:${createHash('sha256').update(label).digest('hex')}`

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value))
const executable = (path, value) => {
  writeFileSync(path, value)
  chmodSync(path, 0o755)
}

const relayMetrics = (relayerAddress) => ({
  chainId,
  registry: addresses.registry,
  relayerAddress,
  easAddress: addresses.eas,
  easVersion: '1.3.0',
  schemaUid,
  submissions: 0,
  validationFailures: 0,
  newestAnchorCount: '0',
  storageExactSuccesses: 0,
  storageTargetCount: 2,
  storageQuorumRequired: 2,
  workCount: '0',
  maxTotalInputs: '0',
  relayerLagEntries: '0',
})

const operatorStatus = () => ({
  chain_id: Number(chainId),
  head_block: 1234,
  tick_at: Math.floor(Date.now() / 1000),
  instances: [
    {
      instance_id: instanceId,
      name: 'dark-canary',
      program: 'trust-graph',
      snapshot: addresses.snapshot,
      curated: true,
      action: { idle: 'quiet' },
      blocks_since_root: null,
      newest_anchor_count: 0,
      input_work: 0,
      input_capacity: Number(cap),
      envelope0_fetch_latency_ms: null,
      envelope0_exact_readers: null,
      envelope0_validation_failed: false,
      unprovable_age_blocks: null,
    },
  ],
  settings: {
    prover_backend: 'network',
    groth16: true,
    confirmations: 12,
    track_block_hash: true,
    publishes_scores: true,
    verifies_score_readback: true,
    publication_target_count: 2,
    publication_min_success: 2,
  },
  unresolved: [],
  alerts: [],
})

const harness = (mutate = () => {}) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'eas-dark-audit-'))
  const bin = resolve(directory, 'bin')
  mkdirSync(bin)
  const paramsPath = resolve(directory, 'params.json')
  const reportPath = resolve(directory, 'report.json')
  const state = {
    relayA: relayMetrics(addresses.relayerA),
    relayB: relayMetrics(addresses.relayerB),
    operator: operatorStatus(),
    indexerHeadDomain: headDomain,
    evidence: {
      deploymentVerification: evidence('deployment-verification'),
      relayerCustody: evidence('relayer-custody'),
      storageIndependence: evidence('storage-independence'),
      alertDelivery: evidence('alert-delivery'),
      backupRestore: evidence('backup-restore'),
      recoveryExports: evidence('recovery-exports'),
      featureHidden: evidence('feature-hidden'),
    },
  }
  mutate(state)

  writeJson(paramsPath, {
    schema_uid: schemaUid,
    envelope0_domain_separators: [easDomain, headDomain],
    lane2_max_head_age: 0,
    accumulator: addresses.accumulator,
    chain_id: Number(chainId),
  })
  writeJson(resolve(directory, 'instances.json'), {
    instances: [
      {
        instanceId,
        admin: addresses.admin,
        snapshot: addresses.snapshot,
        accumulator: addresses.accumulator,
        anchorRegistry: addresses.registry,
        factory: addresses.factory,
        eas: addresses.eas,
        schemaUid,
        paramsPath,
        verifier: addresses.verifier,
      },
    ],
  })
  writeJson(resolve(directory, 'relay-a-metrics.json'), state.relayA)
  writeJson(resolve(directory, 'relay-b-metrics.json'), state.relayB)
  writeJson(resolve(directory, 'operator-status.json'), state.operator)
  writeJson(resolve(directory, 'indexer-config.json'), {
    lane: {
      registry: addresses.registry,
      factory: addresses.factory,
      instanceId,
      chainId,
      eas: addresses.eas,
      easVersion: '1.3.0',
      schemaUid,
      domainSeparator: easDomain,
      headDomainSeparator: state.indexerHeadDomain,
      maxTotalInputs: cap,
    },
  })
  writeJson(resolve(directory, 'indexer-utilization.json'), {
    registry: addresses.registry,
    maxTotalInputs: cap,
  })

  executable(
    resolve(bin, 'cargo'),
    String.raw`#!/usr/bin/env bash
set -euo pipefail
out=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --out-dir ]; then out="$2"; shift 2; else shift; fi
done
[ -n "$out" ]
mkdir -p "$out"
cp "$FAKE_STATE_DIR/instances.json" "$out/instances.json"
printf '{"status":"mock-scan"}\n'
`
  )
  executable(
    resolve(bin, 'cast'),
    String.raw`#!/usr/bin/env bash
set -euo pipefail
command="$1"
shift
case "$command" in
  chain-id) printf '%s\n' "$FAKE_CHAIN_ID" ;;
  keccak) printf '%s\n' "$FAKE_ANCHORER_ROLE" ;;
  code) printf '0x6000\n' ;;
  call)
    address="$1"
    signature="$2"
    case "$signature" in
      'zkVerifier()(address)') printf '%s\n' "$FAKE_VERIFIER" ;;
      'gateway()(address)') printf '%s\n' "$FAKE_GATEWAY" ;;
      'programVKey()(bytes32)') printf '%s\n' "$FAKE_PROGRAM_VKEY" ;;
      'maxTotalInputs()(uint64)') printf '%s\n' "$FAKE_CAP" ;;
      'version()(string)') printf '"1.3.0"\n' ;;
      'hasRole(bytes32,address)(bool)')
        role="$3"
        account="$(printf '%s' "$4" | tr '[:upper:]' '[:lower:]')"
        admin="$(printf '%s' "$FAKE_ADMIN" | tr '[:upper:]' '[:lower:]')"
        relayer_a="$(printf '%s' "$FAKE_RELAYER_A" | tr '[:upper:]' '[:lower:]')"
        relayer_b="$(printf '%s' "$FAKE_RELAYER_B" | tr '[:upper:]' '[:lower:]')"
        if [ "$role" = "$FAKE_ZERO_ROLE" ]; then
          [ "$account" = "$admin" ] && printf 'true\n' || printf 'false\n'
        else
          if [ "$account" = "$relayer_a" ] || [ "$account" = "$relayer_b" ]; then
            printf 'true\n'
          else
            printf 'false\n'
          fi
        fi
        ;;
      *) printf 'unexpected cast call: %s %s\n' "$address" "$signature" >&2; exit 2 ;;
    esac
    ;;
  *) printf 'unexpected cast command: %s\n' "$command" >&2; exit 2 ;;
esac
`
  )
  executable(
    resolve(bin, 'curl'),
    String.raw`#!/usr/bin/env bash
set -euo pipefail
url=
for value in "$@"; do url="$value"; done
case "$url" in
  */relay-a/healthz|*/relay-b/healthz) printf '{"status":"ok"}\n' ;;
  */relay-a/metrics) cat "$FAKE_STATE_DIR/relay-a-metrics.json" ;;
  */relay-b/metrics) cat "$FAKE_STATE_DIR/relay-b-metrics.json" ;;
  */eas-offchain/*/config) cat "$FAKE_STATE_DIR/indexer-config.json" ;;
  */eas-offchain/*/utilization) cat "$FAKE_STATE_DIR/indexer-utilization.json" ;;
  */operator/status.json) cat "$FAKE_STATE_DIR/operator-status.json" ;;
  *) printf 'unexpected curl URL: %s\n' "$url" >&2; exit 2 ;;
esac
`
  )

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_STATE_DIR: directory,
    FAKE_CHAIN_ID: chainId,
    FAKE_ANCHORER_ROLE: anchorerRole,
    FAKE_ZERO_ROLE: zeroRole,
    FAKE_ADMIN: addresses.admin,
    FAKE_RELAYER_A: addresses.relayerA,
    FAKE_RELAYER_B: addresses.relayerB,
    FAKE_VERIFIER: addresses.verifier,
    FAKE_GATEWAY: addresses.gateway,
    FAKE_PROGRAM_VKEY: programVKey,
    FAKE_CAP: cap,
    TESTNET_RPC_URL: 'https://secret-rpc.example.invalid',
    TESTNET_INSTANCE_REGISTRY: addresses.directory,
    TESTNET_REGISTRY_FROM_BLOCK: '100',
    TESTNET_INSTANCE_ID: instanceId,
    TESTNET_EXPECTED_CHAIN_ID: chainId,
    TESTNET_EXPECTED_ADMIN: addresses.admin,
    TESTNET_RELAYER_A: addresses.relayerA,
    TESTNET_RELAYER_B: addresses.relayerB,
    TESTNET_RELAY_URL_A: 'https://audit.example/relay-a',
    TESTNET_RELAY_URL_B: 'https://audit.example/relay-b',
    TESTNET_EXPECTED_VERIFIER: addresses.verifier,
    TESTNET_EXPECTED_GATEWAY: addresses.gateway,
    TESTNET_EXPECTED_PROGRAM_VKEY: programVKey,
    TESTNET_EXPECTED_MAX_TOTAL_INPUTS: cap,
    TESTNET_INDEXER_API: 'https://audit.example/indexer',
    TESTNET_OPERATOR_STATUS_URL: 'https://audit.example/operator/status.json',
    TESTNET_CONFIRMATIONS: '12',
    TESTNET_DEPLOYMENT_VERIFICATION_EVIDENCE:
      state.evidence.deploymentVerification,
    TESTNET_RELAYER_CUSTODY_EVIDENCE: state.evidence.relayerCustody,
    TESTNET_STORAGE_INDEPENDENCE_EVIDENCE: state.evidence.storageIndependence,
    TESTNET_ALERT_DELIVERY_EVIDENCE: state.evidence.alertDelivery,
    TESTNET_BACKUP_RESTORE_EVIDENCE: state.evidence.backupRestore,
    TESTNET_RECOVERY_EXPORT_EVIDENCE: state.evidence.recoveryExports,
    TESTNET_FEATURE_HIDDEN_EVIDENCE: state.evidence.featureHidden,
    TESTNET_AUDIT_REPORT_FILE: reportPath,
  }
  const result = spawnSync('bash', [audit], {
    cwd: root,
    env,
    encoding: 'utf8',
  })
  return {
    directory,
    reportPath,
    result,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  }
}

test('dark-deploy audit binds chain, services, relayer identities, and operator policy', () => {
  const run = harness()
  try {
    assert.equal(run.result.status, 0, run.result.stdout + run.result.stderr)
    assert.match(run.result.stdout, /DARK-DEPLOY GATE PASS/)
    const report = JSON.parse(readFileSync(run.reportPath, 'utf8'))
    assert.equal(report.status, 'dark-deploy-gate-passed')
    assert.equal(report.operator.settings.publication_min_success, 2)
    assert.equal(report.relays.a.relayerAddress, addresses.relayerA)
    assert.equal(
      report.requiredEvidence.backupRestore,
      evidence('backup-restore')
    )
    assert.equal(report.manualEvidenceStillRequired, undefined)
    assert.equal(
      JSON.stringify(report).includes('secret-rpc.example.invalid'),
      false
    )
    assert.equal(JSON.stringify(report).includes('audit.example'), false)
  } finally {
    run.cleanup()
  }
})

test('dark-deploy audit rejects endpoint-to-relayer substitution', () => {
  const run = harness((state) => {
    state.relayB.relayerAddress = addresses.relayerA
  })
  try {
    assert.equal(run.result.status, 1, run.result.stdout + run.result.stderr)
    assert.match(
      run.result.stderr,
      /relay b is not bound to its expected relayer key/
    )
  } finally {
    run.cleanup()
  }
})

test('dark-deploy audit rejects an indexer with a substituted head domain', () => {
  const run = harness((state) => {
    state.indexerHeadDomain = hex('ff', 32)
  })
  try {
    assert.equal(run.result.status, 1, run.result.stdout + run.result.stderr)
    assert.match(run.result.stderr, /another head-signature domain/)
  } finally {
    run.cleanup()
  }
})

test('dark-deploy audit rejects stale or under-replicated operator state', () => {
  const stale = harness((state) => {
    state.operator.tick_at -= 1_000
  })
  try {
    assert.equal(
      stale.result.status,
      1,
      stale.result.stdout + stale.result.stderr
    )
    assert.match(stale.result.stderr, /operator heartbeat is stale/)
  } finally {
    stale.cleanup()
  }

  const underReplicated = harness((state) => {
    state.operator.settings.publication_target_count = 1
    state.operator.settings.publication_min_success = 1
  })
  try {
    assert.equal(
      underReplicated.result.status,
      1,
      underReplicated.result.stdout + underReplicated.result.stderr
    )
    assert.match(
      underReplicated.result.stderr,
      /operator policy\/readers\/finality or active-alert state is not rollout-safe/
    )
  } finally {
    underReplicated.cleanup()
  }
})

test('dark-deploy gate rejects missing or mutable operational evidence', () => {
  const missing = harness((state) => {
    state.evidence.recoveryExports = ''
  })
  try {
    assert.equal(
      missing.result.status,
      1,
      missing.result.stdout + missing.result.stderr
    )
    assert.match(
      missing.result.stderr,
      /TESTNET_RECOVERY_EXPORT_EVIDENCE is required/
    )
  } finally {
    missing.cleanup()
  }

  const mutable = harness((state) => {
    state.evidence.alertDelivery = 'https://mutable.example/alerts/latest'
  })
  try {
    assert.equal(
      mutable.result.status,
      1,
      mutable.result.stdout + mutable.result.stderr
    )
    assert.match(
      mutable.result.stderr,
      /TESTNET_ALERT_DELIVERY_EVIDENCE must be an immutable/
    )
  } finally {
    mutable.cleanup()
  }
})
