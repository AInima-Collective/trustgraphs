import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SepoliaEnv } from './env'
import { resolveDeploymentSelection } from './profiles'
import {
  loadReleaseManifest,
  readBroadcastDeployments,
  releaseManifestToDeploymentSummary,
  validateReleaseManifest,
} from './release-manifest'

const MANIFEST = 'deployments/sepolia.json'
const ADDRESS = '0x1111111111111111111111111111111111111111'
const TX_HASH = `0x${'22'.repeat(32)}` as `0x${string}`
const BYTES32 = `0x${'33'.repeat(32)}` as `0x${string}`

test('tracked Sepolia manifest is sanitized, chain-bound, and complete for its status', () => {
  const manifest = loadReleaseManifest(MANIFEST)
  const serialized = fs.readFileSync(MANIFEST, 'utf8')

  assert.equal(manifest.stage, 'production')
  assert.equal(manifest.chain, 'sepolia')
  assert.equal(manifest.chainId, 11155111)
  assert.doesNotMatch(serialized, /rpc_url|rpcUrl|privateKey|fundedKey|secret/i)

  // A real deploy writes its record straight over this file, because the Sepolia profile names
  // it as `releaseManifestFile` and it is also tracked. So `planned` (the committed template)
  // and `deployed` (a working tree that has deployed) are both honest states, and pinning the
  // assertion to `planned` made the suite go red on exactly the machines doing the work — the
  // fastest way to teach someone to ignore a red suite on deploy day. What must hold either way
  // is that the file carries no secrets and is complete for whatever it claims to be.
  assert.ok(['planned', 'deployed'].includes(manifest.status))
  if (manifest.status === 'planned') {
    assert.throws(
      () => loadReleaseManifest(MANIFEST, { requireComplete: true }),
      /status=deployed/
    )
  } else {
    assert.doesNotThrow(() =>
      loadReleaseManifest(MANIFEST, { requireComplete: true })
    )
  }
})

test('manifest validator rejects unknown fields and secret-bearing keys', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  assert.throws(
    () => validateReleaseManifest({ ...manifest, rpc_url: 'https://secret' }),
    /forbidden/
  )
  assert.throws(
    () => validateReleaseManifest({ ...manifest, surprise: true }),
    /unknown key/
  )
})

test('stage and target resolve independently', () => {
  assert.deepEqual(
    resolveDeploymentSelection({ stage: 'production', target: 'sepolia' }),
    {
      stage: 'production',
      target: 'sepolia',
      envName: 'prod',
      profile: resolveDeploymentSelection({ target: 'sepolia' }).profile,
    }
  )
  assert.throws(
    () => resolveDeploymentSelection({ stage: 'production' }),
    /explicit chain target/
  )
  assert.throws(
    () =>
      resolveDeploymentSelection({ stage: 'development', target: 'sepolia' }),
    /cannot target public chain/
  )
})

test('Sepolia plan is trust-graph only and reuses canonical EAS', () => {
  const previous = { ...process.env }
  // `validateDeployment` refuses to plan a public-chain deploy whose vkeys are not the ones a
  // release published, so the fixture stands in for `guest-manifest.json` here.
  const guestManifest = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'trustgraphs-guests-')),
    'guest-manifest.json'
  )
  fs.writeFileSync(
    guestManifest,
    JSON.stringify({
      tag: 'v0.0.0-test',
      commit: 'aa'.repeat(20),
      programs: [
        {
          program: 'trust-graph',
          vkey: BYTES32,
          elf_sha256: '44'.repeat(32),
        },
      ],
    })
  )
  Object.assign(process.env, {
    SP1_VERIFIER_GATEWAY: ADDRESS,
    SP1_PROGRAM_VKEY: BYTES32,
    INSTANCE_REGISTRY_ADMIN: ADDRESS,
    FACTORY_EPOCH_FLOOR: '7200',
    DEPLOYMENT_COMMIT: 'aa'.repeat(20),
    SP1_PROGRAM_ELF_SHA256: `0x${'44'.repeat(32)}`,
    ETH_USD_FEED: ADDRESS,
    USDC: ADDRESS,
    GUEST_MANIFEST: guestManifest,
  })
  try {
    const env = new SepoliaEnv({ rpcUrl: 'https://rpc.invalid' })
    env.validateDeployment?.()
    assert.equal(env.profile.chainId, 11155111)
    assert.deepEqual(env.deployContracts[0].args({} as never), [
      loadReleaseManifest(MANIFEST).external.eas,
      loadReleaseManifest(MANIFEST).external.schemaRegistry,
    ])
    assert.deepEqual(
      env.deployContracts.map(({ name }) => name),
      [
        'Schema Registrar (canonical Sepolia EAS)',
        'Trust-graph ZK Verifier',
        'Instance Registry',
        'Proving Vault',
        'Trustgraphs Factory',
      ]
    )
    assert.doesNotMatch(JSON.stringify(env.deployContracts), /compose|signer/i)
  } finally {
    process.env = previous
  }
})

// The failure this exists for happened on Sepolia on 2026-08-25: `SP1_PROGRAM_VKEY` held a
// local (non-`--docker`) trust-graph build, every shape check passed, and the verifier fixed the
// wrong vkey into an immutable. Nothing downstream could have caught it — a locally built vkey is
// well-formed bytes32, and `.docker/zk_verifier_deploy.json` agreed with it because the same run
// wrote both.
test('Sepolia planning refuses vkeys that are not in the release', () => {
  const previous = { ...process.env }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trustgraphs-guests-'))
  const guestManifest = path.join(dir, 'guest-manifest.json')
  fs.writeFileSync(
    guestManifest,
    JSON.stringify({
      tag: 'v0.0.0-test',
      commit: 'aa'.repeat(20),
      programs: [
        { program: 'trust-graph', vkey: BYTES32, elf_sha256: '44'.repeat(32) },
      ],
    })
  )
  const base = {
    SP1_VERIFIER_GATEWAY: ADDRESS,
    SP1_PROGRAM_VKEY: BYTES32,
    INSTANCE_REGISTRY_ADMIN: ADDRESS,
    FACTORY_EPOCH_FLOOR: '7200',
    DEPLOYMENT_COMMIT: 'aa'.repeat(20),
    SP1_PROGRAM_ELF_SHA256: `0x${'44'.repeat(32)}`,
    ETH_USD_FEED: ADDRESS,
    USDC: ADDRESS,
    GUEST_MANIFEST: guestManifest,
  }
  const plan = () =>
    new SepoliaEnv({ rpcUrl: 'https://rpc.invalid' }).validateDeployment?.()
  try {
    Object.assign(process.env, base, { SP1_PROGRAM_VKEY: `0x${'55'.repeat(32)}` })
    assert.throws(plan, /is a local build/)

    // A digest from one build and a vkey from another describe different ELFs.
    Object.assign(process.env, base, {
      SP1_PROGRAM_ELF_SHA256: `0x${'66'.repeat(32)}`,
    })
    assert.throws(plan, /SP1_PROGRAM_ELF_SHA256/)

    // A manifest from some other release proves nothing about these pins.
    Object.assign(process.env, base, { DEPLOYMENT_COMMIT: 'bb'.repeat(20) })
    assert.throws(plan, /was built at commit/)

    // Fail closed when the release artifact is simply absent.
    Object.assign(process.env, base, {
      GUEST_MANIFEST: path.join(dir, 'absent.json'),
    })
    assert.throws(plan, /gh release download/)

    Object.assign(process.env, base)
    assert.doesNotThrow(plan)
  } finally {
    process.env = previous
  }
})

test('broadcast receipts populate the consumer adapter without RPC access', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trustgraphs-manifest-'))
  const runDir = path.join(root, 'broadcast', 'Deploy.s.sol', '11155111')
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(
    path.join(runDir, 'run-latest.json'),
    JSON.stringify({
      transactions: [{ hash: TX_HASH, contractAddress: ADDRESS }],
      receipts: [
        {
          transactionHash: TX_HASH,
          blockNumber: '0x7b',
          contractAddress: ADDRESS,
        },
      ],
    })
  )

  assert.deepEqual(
    readBroadcastDeployments(root, 11155111).get(ADDRESS.toLowerCase()),
    {
      block: 123,
      txHash: TX_HASH,
    }
  )

  const planned = loadReleaseManifest(MANIFEST)
  const summary = releaseManifestToDeploymentSummary({
    ...planned,
    contracts: {
      ...planned.contracts,
      instanceRegistry: { address: ADDRESS, block: 123, txHash: TX_HASH },
    },
  })
  assert.equal(summary.factory.instance_registry, ADDRESS)
})
