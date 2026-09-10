import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { keccak256, toBytes } from 'viem'

import { MainnetEnv, getEnv, safeTransactionBatch } from './env'
import { generationManifestPath } from './generation'
import { PUBLIC_CHAIN_PLANS, hostedFamilyKeys } from './public-chains'
import {
  type ReleaseManifest,
  loadReleaseManifest,
  releaseChainOf,
} from './release-manifest'
import type { ProgramContext } from './types'

const SEED = 'deployments/mainnet.json'
const ADDRESS = '0x1111111111111111111111111111111111111111'
const ADMIN = '0x' + 'fe'.repeat(20)
const BYTES32 = `0x${'33'.repeat(32)}` as `0x${string}`
const SIGNER_BYTES32 = `0x${'55'.repeat(32)}` as `0x${string}`
const WEIGHTED_BYTES32 = `0x${'77'.repeat(32)}` as `0x${string}`
const COMPOSITION_BYTES32 = `0x${'88'.repeat(32)}` as `0x${string}`
const CONTRIBUTIONS_BYTES32 = `0x${'99'.repeat(32)}` as `0x${string}`
const commit = 'aa'.repeat(20)
const builder = fs.readFileSync('zk/sp1-builder-image.txt', 'utf8').trim()
const guest = {
  tag: 'v0.0.0-test',
  commit,
  guest_build: 'docker',
  builder_image: builder,
  programs: [
    { program: 'trust-graph', vkey: BYTES32, elf_sha256: '44'.repeat(32) },
    {
      program: 'signer-sync',
      vkey: SIGNER_BYTES32,
      elf_sha256: '66'.repeat(32),
    },
    {
      program: 'trust-graph-weighted',
      vkey: WEIGHTED_BYTES32,
      elf_sha256: '77'.repeat(32),
    },
    {
      program: 'trust-compose',
      vkey: COMPOSITION_BYTES32,
      elf_sha256: '88'.repeat(32),
    },
    {
      program: 'contributions',
      vkey: CONTRIBUTIONS_BYTES32,
      elf_sha256: '99'.repeat(32),
    },
  ],
}

const releaseEnvironment = (guestManifest: string) => ({
  SP1_VERIFIER_GATEWAY: ADDRESS,
  SP1_PROGRAM_VKEY: BYTES32,
  SP1_SIGNER_PROGRAM_VKEY: SIGNER_BYTES32,
  SP1_WEIGHTED_PROGRAM_VKEY: WEIGHTED_BYTES32,
  SP1_COMPOSITION_PROGRAM_VKEY: COMPOSITION_BYTES32,
  CONTRIBUTIONS_PROGRAM_VKEY: CONTRIBUTIONS_BYTES32,
  INSTANCE_REGISTRY_ADMIN: ADMIN,
  DEPLOYMENT_COMMIT: commit,
  SP1_PROGRAM_ELF_SHA256: `0x${'44'.repeat(32)}`,
  GUEST_MANIFEST: guestManifest,
})

const withGuestManifest = () => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'trustgraphs-mainnet-guests-')),
    'guest-manifest.json'
  )
  fs.writeFileSync(file, JSON.stringify(guest))
  return file
}

test('the tracked mainnet seed is a planned chain-1 manifest with canonical externals', () => {
  const seed = loadReleaseManifest(SEED, { expectedChain: 'mainnet' })
  assert.equal(seed.status, 'planned')
  assert.equal(seed.chainId, 1)
  assert.equal(releaseChainOf(seed), 'mainnet')
  assert.equal(seed.instances.length, 0)
  assert.equal(seed.firstDeploymentBlock, null)
  // The generation-1 plan leaves the imported-EAS family out: absent, not null.
  assert.equal('importedTrustgraphsFactory' in seed.contracts, false)
  assert.equal('governedImportedTrustgraphsFactory' in seed.contracts, false)
  // Canonical Safe 1.3.0 and the same SP1 gateway CREATE2 address as Sepolia.
  const sepolia = loadReleaseManifest('deployments/sepolia.json')
  assert.equal(
    seed.contracts.safeSingleton.address,
    sepolia.contracts.safeSingleton.address
  )
  assert.equal(seed.external.sp1Gateway, sepolia.external.sp1Gateway)
  assert.notEqual(seed.external.eas, sepolia.external.eas)
  // Same released guests as the live Sepolia generation.
  assert.deepEqual(seed.programs, sepolia.programs)
  assert.throws(() => loadReleaseManifest(SEED), /Sepolia manifest must bind/)
})

test('mainnet resolves only as a production target and plans the same steps minus the imported family', () => {
  const previous = { ...process.env }
  Object.assign(process.env, releaseEnvironment(withGuestManifest()), {
    FACTORY_EPOCH_FLOOR: '7200',
  })
  try {
    assert.throws(
      () => getEnv('development', 'mainnet', { rpcUrl: 'https://rpc.invalid' }),
      /Invalid deployment selection/
    )
    const env = getEnv('production', 'mainnet', {
      rpcUrl: 'https://rpc.invalid',
    })
    assert.ok(env instanceof MainnetEnv)
    assert.equal(env.profile.chainId, 1)
    assert.equal(env.profile.releaseManifestFile, SEED)
    assert.equal(env.networksConfigFile, 'config/networks.mainnet.json')
    assert.equal(env.triggerChain, 'evm:1')
    env.validateDeployment?.()
    const seed = loadReleaseManifest(SEED, { expectedChain: 'mainnet' })
    assert.deepEqual(env.deployContracts[0]!.args({} as never), [
      seed.external.eas,
      seed.external.schemaRegistry,
    ])
    assert.equal(
      env.deployContracts[3]!.env?.({} as never).FEED_MAX_STALENESS,
      PUBLIC_CHAIN_PLANS.mainnet.feedMaxStaleness
    )
    const fresh = { options: {} } as never
    assert.deepEqual(
      env.deployContracts
        .filter((step) => step.skip?.(fresh))
        .map((step) => step.name),
      ['Imported EAS Factory', 'Governed Imported EAS Factory']
    )
    assert.equal(
      env.deployContracts.filter((step) => !step.skip?.(fresh)).length,
      16
    )
    assert.deepEqual(env.deployContracts.slice(-2).map((step) => step.name), [
      'Hand off Proving Vault',
      'Hand off Subnetwork Registry',
    ])
    assert.equal(
      generationManifestPath('v1', 'mainnet'),
      'deployments/generations/v1/mainnet.json'
    )
    const families = (target: 'sepolia' | 'mainnet'): readonly string[] =>
      hostedFamilyKeys(target)
    assert.ok(!families('mainnet').includes('importedTrustgraphsFactory'))
    assert.ok(families('sepolia').includes('importedTrustgraphsFactory'))
  } finally {
    process.env = previous
  }
})

test('a sub-day epoch floor on mainnet needs the mainnet opt-in, not the testnet one', () => {
  const previous = { ...process.env }
  Object.assign(process.env, releaseEnvironment(withGuestManifest()), {
    FACTORY_EPOCH_FLOOR: '1',
  })
  delete process.env.ALLOW_MAINNET_EPOCH_FLOOR
  delete process.env.ALLOW_TESTNET_EPOCH_FLOOR
  try {
    const env = new MainnetEnv({ rpcUrl: 'https://rpc.invalid' })
    assert.throws(
      () => env.validateDeployment?.(),
      /ALLOW_MAINNET_EPOCH_FLOOR=true/
    )
    process.env.ALLOW_TESTNET_EPOCH_FLOOR = 'true'
    assert.throws(
      () => env.validateDeployment?.(),
      /ALLOW_MAINNET_EPOCH_FLOOR=true/
    )
    process.env.ALLOW_MAINNET_EPOCH_FLOOR = 'true'
    env.validateDeployment?.()
  } finally {
    process.env = previous
  }
})

test('a fresh mainnet broadcast finalizes the seed without the imported family and batches the admin grants', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trustgraphs-mainnet-plan-'))
  const originalCwd = process.cwd()
  const originalEnv = { ...process.env }
  t.after(() => {
    process.chdir(originalCwd)
    process.env = originalEnv
    fs.rmSync(root, { recursive: true, force: true })
  })
  const seedBytes = fs.readFileSync(SEED, 'utf8')
  for (const dir of ['deployments', 'zk', '.docker', 'broadcast/Mainnet.s.sol/1']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  fs.writeFileSync(path.join(root, SEED), seedBytes)
  fs.writeFileSync(path.join(root, 'guest-manifest.json'), JSON.stringify(guest))
  fs.writeFileSync(path.join(root, 'zk/sp1-builder-image.txt'), `${builder}\n`)
  process.chdir(root)
  for (const key of ['SKIP_PROVING_VAULT', 'HYPERCERTS_PROGRAM_VKEY', 'NOSTR_WORKSPACE_VKEY'])
    delete process.env[key]
  Object.assign(
    process.env,
    releaseEnvironment(path.join(root, 'guest-manifest.json')),
    { FACTORY_EPOCH_FLOOR: '1', ALLOW_MAINNET_EPOCH_FLOOR: 'true' }
  )
  const env = new MainnetEnv({ rpcUrl: 'https://rpc.invalid' })
  env.validateDeployment?.()
  const context: ProgramContext = {
    envName: 'prod',
    stage: 'production',
    target: 'mainnet',
    env,
    options: {},
    dotenv: {},
  }
  const files: Record<string, [string, string]> = {
    'Schema Registrar (canonical EAS)': ['eas', 'schema_registrar'],
    'Trust-graph ZK Verifier': ['zk_verifier', 'zk_verifier'],
    'Instance Registry': ['instance_registry', 'instance_registry'],
    'Proving Vault': ['proving_vault', 'proving_vault'],
    'Trustgraphs Factory': ['factory', 'factory'],
    'Signer ZK Verifier': ['zk_verifier_signer', 'zk_verifier'],
    'Governed Factory': ['governed_factory', 'governed_factory'],
    'Weighted ZK Verifier': ['zk_verifier_weighted', 'zk_verifier'],
    'Weighted Factory': ['weighted_factory', 'weighted_factory'],
    'Governed Weighted Factory': ['governed_weighted_factory', 'governed_weighted_factory'],
    'Composition ZK Verifier': ['zk_verifier_composition', 'zk_verifier'],
    'Trust Compose Factory': ['trust_compose_factory', 'trust_compose_factory'],
    'Governed Compose Factory': ['governed_compose_factory', 'governed_compose_factory'],
    'Contributions Factory': ['contributions_factory', 'contributions_factory'],
  }
  const vkeys: Record<string, `0x${string}`> = {
    'Trust-graph ZK Verifier': BYTES32,
    'Signer ZK Verifier': SIGNER_BYTES32,
    'Weighted ZK Verifier': WEIGHTED_BYTES32,
    'Composition ZK Verifier': COMPOSITION_BYTES32,
    'Contributions Factory': CONTRIBUTIONS_BYTES32,
  }
  let serial = 2000
  const receipts: object[] = []
  const transactions: object[] = []
  const nextAddress = () => {
    serial++
    const address = `0x${serial.toString(16).padStart(40, '0')}`
    const hash = `0x${serial.toString(16).padStart(64, '0')}`
    transactions.push({ contractAddress: address, hash })
    receipts.push({ transactionHash: hash, blockNumber: serial })
    return address
  }
  const seed = JSON.parse(seedBytes) as ReleaseManifest
  for (const step of env.deployContracts) {
    if (step.skip?.(context)) {
      assert.match(step.name, /Imported/)
      continue
    }
    const entry = files[step.name]
    if (!entry) {
      assert.match(step.name, /^Hand off/)
      const [target, admin, roles] = step.args(context)
      assert.match(String(target), /^0x[0-9a-f]{40}$/i)
      assert.equal(admin, ADMIN)
      assert.match(String(roles), /DEFAULT_ADMIN_ROLE/)
      continue
    }
    step.args(context)
    const [file, field] = entry
    const artifact: Record<string, string> = { [field]: nextAddress() }
    if (vkeys[step.name]) artifact.program_vkey = vkeys[step.name]!
    if (step.name === 'Governed Factory')
      Object.assign(artifact, {
        signer_sync_deployer: nextAddress(),
        parent_authority_deployer: nextAddress(),
        subnetwork_registry: nextAddress(),
        safe_singleton: seed.contracts.safeSingleton.address!,
        safe_factory: seed.contracts.safeProxyFactory.address!,
      })
    if (step.name === 'Contributions Factory') artifact.zk_verifier = nextAddress()
    if (step.name === 'Proving Vault')
      Object.assign(artifact, {
        eth_usd_feed: seed.external.ethUsdFeed!,
        usdc: seed.external.usdc!,
      })
    fs.writeFileSync(`.docker/${file}_deploy.json`, JSON.stringify(artifact))
    step.postRun?.(context)
  }
  fs.writeFileSync(
    'broadcast/Mainnet.s.sol/1/run-latest.json',
    JSON.stringify({ transactions, receipts })
  )
  env.postDeployContracts?.()
  const batch = JSON.parse(
    fs.readFileSync('.docker/admin-grants.mainnet.json', 'utf8')
  ) as ReturnType<typeof safeTransactionBatch>
  assert.equal(batch.chainId, '1')
  assert.equal(batch.transactions.length, 4)
  for (const transaction of batch.transactions) {
    assert.match(transaction.data, /^0x2f2ff15d/)
    assert.equal(transaction.contractMethod.name, 'grantRole')
    assert.equal(transaction.to, JSON.parse(fs.readFileSync('.docker/instance_registry_deploy.json', 'utf8')).instance_registry)
  }
  assert.deepEqual(
    batch.transactions.map((transaction) => transaction.contractInputsValues.account),
    ['factory', 'weighted_factory', 'trust_compose_factory', 'contributions_factory'].map(
      (key, index) =>
        JSON.parse(
          fs.readFileSync(
            `.docker/${['factory', 'weighted_factory', 'trust_compose_factory', 'contributions_factory'][index]}_deploy.json`,
            'utf8'
          )
        )[key]
    )
  )

  const deployed = env.generateReleaseManifest(context) as ReleaseManifest
  assert.equal(deployed.status, 'deployed')
  assert.equal(deployed.chain, 'mainnet')
  assert.equal(deployed.chainId, 1)
  assert.equal(deployed.deploymentCommit, commit)
  assert.equal(deployed.firstDeploymentBlock, 2001)
  assert.equal('importedTrustgraphsFactory' in deployed.contracts, false)
  assert.equal('governedImportedTrustgraphsFactory' in deployed.contracts, false)
  for (const key of hostedFamilyKeys('mainnet')) {
    const record = deployed.contracts[key]
    assert.ok(record?.address && record.block !== null, key)
  }
  assert.equal(deployed.programs.trustGraph.vkey, BYTES32)
  assert.deepEqual(deployed.programs.hypercerts, seed.programs.hypercerts)
  assert.deepEqual(deployed.instances, [])
  loadReleaseManifest(SEED, { expectedChain: 'mainnet' })
})

test('the Safe batch encodes grantRole with the zero admin role and keccak names', () => {
  const batch = safeTransactionBatch(1, [
    { label: 'a', contract: ADDRESS, role: 'DEFAULT_ADMIN_ROLE', account: ADMIN },
    { label: 'b', contract: ADDRESS, role: 'REGISTRAR_ROLE', account: ADMIN },
  ])
  assert.equal(
    batch.transactions[0]!.contractInputsValues.role,
    `0x${'0'.repeat(64)}`
  )
  assert.equal(
    batch.transactions[1]!.contractInputsValues.role,
    keccak256(toBytes('REGISTRAR_ROLE'))
  )
  for (const transaction of batch.transactions) {
    assert.match(transaction.data, /^0x2f2ff15d/)
    assert.equal(transaction.to, ADDRESS)
    assert.equal(transaction.value, '0')
    assert.equal(transaction.contractInputsValues.account, ADMIN)
  }
})
