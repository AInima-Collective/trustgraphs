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

test('tracked Sepolia manifest is planned, sanitized, and chain-bound', () => {
  const manifest = loadReleaseManifest(MANIFEST)
  const serialized = fs.readFileSync(MANIFEST, 'utf8')

  assert.equal(manifest.stage, 'production')
  assert.equal(manifest.chain, 'sepolia')
  assert.equal(manifest.chainId, 11155111)
  assert.equal(manifest.status, 'planned')
  assert.doesNotMatch(serialized, /rpc_url|rpcUrl|privateKey|fundedKey|secret/i)
  assert.throws(
    () => loadReleaseManifest(MANIFEST, { requireComplete: true }),
    /status=deployed/
  )
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

test('stage and target resolve independently without retargeting legacy prod', () => {
  assert.deepEqual(
    resolveDeploymentSelection({ stage: 'production', target: 'sepolia' }),
    {
      stage: 'production',
      target: 'sepolia',
      envName: 'prod',
      profile: resolveDeploymentSelection({ target: 'sepolia' }).profile,
    }
  )
  assert.equal(
    resolveDeploymentSelection({ legacyEnv: 'prod' }).target,
    'optimism'
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
  Object.assign(process.env, {
    SP1_VERIFIER_GATEWAY: ADDRESS,
    SP1_PROGRAM_VKEY: BYTES32,
    INSTANCE_REGISTRY_ADMIN: ADDRESS,
    FACTORY_EPOCH_FLOOR: '7200',
    DEPLOYMENT_COMMIT: 'aa'.repeat(20),
    SP1_PROGRAM_ELF_SHA256: `0x${'44'.repeat(32)}`,
    ETH_USD_FEED: ADDRESS,
    USDC: ADDRESS,
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
