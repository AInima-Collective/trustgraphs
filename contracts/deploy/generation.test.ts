import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SepoliaEnv } from './env'
import {
  assertGenerationComplete,
  beginGeneration,
  generationManifestPath,
  planGeneration,
} from './generation'
import {
  CURRENT_SP1_CIRCUIT_VERSION,
  CURRENT_SP1_VERSION,
  RELEASE_PROGRAMS,
  loadReleaseManifest,
  type ReleaseManifest,
} from './release-manifest'
import type { ProgramContext } from './types'

const active = loadReleaseManifest('deployments/sepolia.json', {
  requireComplete: true,
})
const commit = 'ab'.repeat(20)
const builder = fs.readFileSync('zk/sp1-builder-image.txt', 'utf8')
const guest = {
  commit,
  sp1: CURRENT_SP1_CIRCUIT_VERSION,
  guest_build: 'docker',
  builder_image: builder.trim(),
  programs: RELEASE_PROGRAMS.map(([, program], index) => ({
    program,
    vkey: `0x${String(index + 1).repeat(64)}`,
    elf_sha256: String(index + 1).repeat(64),
  })),
}

test('replacement plan preserves external identities but never inherits contracts or instances', () => {
  const before = JSON.stringify(active)
  const plan = planGeneration(active, guest, commit)
  assert.equal(JSON.stringify(active), before)
  assert.deepEqual(plan.external, active.external)
  assert.deepEqual(plan.instances, [])
  assert.equal(plan.firstDeploymentBlock, null)
  for (const [key, record] of Object.entries(plan.contracts)) {
    if (key === 'safeSingleton' || key === 'safeProxyFactory') {
      assert.deepEqual(record, active.contracts[key])
    } else
      assert.deepEqual(record, { address: null, block: null, txHash: null })
  }
  for (const [index, [key]] of RELEASE_PROGRAMS.entries()) {
    assert.deepEqual(plan.programs[key], {
      sp1Version: CURRENT_SP1_VERSION,
      vkey: guest.programs[index]!.vkey,
      elfSha256: `0x${guest.programs[index]!.elf_sha256}`,
    })
  }
})

test('replacement rejects incomplete or mismatched guest identities and unsafe names', () => {
  assert.throws(
    () => planGeneration(active, guest, 'cd'.repeat(20)),
    /match DEPLOYMENT_COMMIT/
  )
  assert.throws(
    () => planGeneration(active, { ...guest, sp1: 'v6.3.1' }, commit),
    /requires SP1/
  )
  // The SDK version is not the circuit version; a manifest carrying it was not produced by the
  // release prover.
  assert.throws(
    () =>
      planGeneration(
        active,
        { ...guest, sp1: `v${CURRENT_SP1_VERSION}` },
        commit
      ),
    /requires SP1/
  )
  assert.throws(
    () =>
      planGeneration(
        active,
        { ...guest, programs: guest.programs.slice(1) },
        commit
      ),
    /seven-program/
  )
  const duplicate = structuredClone(guest)
  duplicate.programs[1] = duplicate.programs[0]!
  assert.throws(() => planGeneration(active, duplicate, commit), /unique valid/)
  assert.equal(
    generationManifestPath('v0.1.0-rc.1'),
    'deployments/generations/v0.1.0-rc.1/sepolia.json'
  )
  for (const name of [
    '',
    '../active',
    '/tmp/release',
    'foo/bar',
    'x;echo',
    'a'.repeat(81),
  ]) {
    assert.throws(() => generationManifestPath(name), /Generation name/)
  }
})

test('begin preserves the active manifest, archives provenance, and refuses stale or repeated attempts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trustgraphs-generation-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'deployments'))
  const activeFile = path.join(root, 'deployments/sepolia.json')
  const bytes = `${JSON.stringify(active)}\n`
  fs.writeFileSync(activeFile, bytes)
  const plan = planGeneration(active, guest, commit)
  const start = () =>
    beginGeneration('v0.1.0', plan, bytes, JSON.stringify(guest), root)
  const changedGuest = structuredClone(guest)
  changedGuest.programs[0]!.elf_sha256 = 'ef'.repeat(32)
  assert.throws(
    () =>
      beginGeneration(
        'v0.1.0',
        plan,
        bytes,
        JSON.stringify(changedGuest),
        root
      ),
    /archive inputs changed/
  )
  fs.mkdirSync(path.join(root, '.docker'))
  fs.writeFileSync(path.join(root, '.docker/factory_deploy.json'), '{}')
  assert.throws(start, /clean deployment checkout/)
  assert.equal(fs.existsSync(path.join(root, 'deployments/generations')), false)
  fs.unlinkSync(path.join(root, '.docker/factory_deploy.json'))
  fs.writeFileSync(activeFile, `${bytes}\n`)
  assert.throws(start, /changed while preparing/)
  fs.writeFileSync(activeFile, bytes)
  start()
  assert.equal(fs.readFileSync(activeFile, 'utf8'), bytes)
  assert.equal(
    fs.readFileSync(
      path.join(root, 'deployments/generations/v0.1.0/previous-sepolia.json'),
      'utf8'
    ),
    bytes
  )
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(root, generationManifestPath('v0.1.0')), 'utf8')
    ),
    plan
  )
  assert.throws(start, /EEXIST/)
})

test('all replacement steps resolve fresh dependencies and finalize only complete candidate receipts', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'trustgraphs-generation-plan-')
  )
  const originalCwd = process.cwd()
  const originalEnv = { ...process.env }
  t.after(() => {
    process.chdir(originalCwd)
    process.env = originalEnv
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (const dir of [
    'deployments',
    'zk',
    '.docker',
    'broadcast/Generation.s.sol/11155111',
  ]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  fs.writeFileSync(
    path.join(root, 'deployments/sepolia.json'),
    JSON.stringify(active)
  )
  fs.writeFileSync(
    path.join(root, 'guest-manifest.json'),
    JSON.stringify(guest)
  )
  fs.writeFileSync(path.join(root, 'zk/sp1-builder-image.txt'), builder)
  process.chdir(root)
  for (const key of [
    'SKIP_PROVING_VAULT',
    'HYPERCERTS_PROGRAM_VKEY',
    'NOSTR_WORKSPACE_VKEY',
  ])
    delete process.env[key]
  Object.assign(process.env, {
    GUEST_MANIFEST: path.join(root, 'guest-manifest.json'),
    DEPLOYMENT_COMMIT: commit,
    SP1_PROGRAM_ELF_SHA256: `0x${guest.programs[0]!.elf_sha256}`,
    SP1_PROGRAM_VKEY: guest.programs[0]!.vkey,
    SP1_WEIGHTED_PROGRAM_VKEY: guest.programs[1]!.vkey,
    SP1_COMPOSITION_PROGRAM_VKEY: guest.programs[2]!.vkey,
    SP1_SIGNER_PROGRAM_VKEY: guest.programs[3]!.vkey,
    CONTRIBUTIONS_PROGRAM_VKEY: guest.programs[4]!.vkey,
    INSTANCE_REGISTRY_ADMIN: '0x' + 'fe'.repeat(20),
    FACTORY_EPOCH_FLOOR: '7200',
  })
  const env = new SepoliaEnv({
    rpcUrl: 'https://rpc.invalid',
    newGeneration: 'v0.1.0',
  })
  env.validateDeployment?.()
  const context: ProgramContext = {
    envName: 'prod',
    stage: 'production',
    target: 'sepolia',
    env,
    options: { newGeneration: 'v0.1.0' },
    dotenv: {},
  }
  const files = [
    ['eas', 'schema_registrar'],
    ['zk_verifier', 'zk_verifier'],
    ['instance_registry', 'instance_registry'],
    ['proving_vault', 'proving_vault'],
    ['factory', 'factory'],
    ['imported_factory', 'imported_factory'],
    ['zk_verifier_signer', 'zk_verifier'],
    ['governed_factory', 'governed_factory'],
    ['governed_imported_factory', 'governed_imported_factory'],
    ['zk_verifier_weighted', 'zk_verifier'],
    ['weighted_factory', 'weighted_factory'],
    ['governed_weighted_factory', 'governed_weighted_factory'],
    ['zk_verifier_composition', 'zk_verifier'],
    ['trust_compose_factory', 'trust_compose_factory'],
    ['governed_compose_factory', 'governed_compose_factory'],
    ['contributions_factory', 'contributions_factory'],
  ]
  const oldAddresses = Object.entries(active.contracts)
    .filter(([key]) => key !== 'safeSingleton' && key !== 'safeProxyFactory')
    .map(([, record]) => record.address?.toLowerCase())
    .filter(Boolean)
  let serial = 1000
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
  for (const [index, step] of env.deployContracts.entries()) {
    assert.equal(step.skip?.(context) ?? false, false, step.name)
    for (const arg of step.args(context)) {
      assert.ok(
        !oldAddresses.includes(String(arg).toLowerCase()),
        `${step.name} reused old ${arg}`
      )
    }
    const [file, field] = files[index]!
    const artifact: Record<string, string> = { [field!]: nextAddress() }
    const vkeyIndex = (
      { 1: 0, 6: 3, 9: 1, 12: 2, 15: 4 } as Record<number, number>
    )[index]
    if (vkeyIndex !== undefined)
      artifact.program_vkey = guest.programs[vkeyIndex]!.vkey
    if (index === 7)
      Object.assign(artifact, {
        signer_sync_deployer: nextAddress(),
        parent_authority_deployer: nextAddress(),
        subnetwork_registry: nextAddress(),
        safe_singleton: active.contracts.safeSingleton.address!,
        safe_factory: active.contracts.safeProxyFactory.address!,
      })
    if (index === 15) artifact.zk_verifier = nextAddress()
    fs.writeFileSync(`.docker/${file}_deploy.json`, JSON.stringify(artifact))
  }
  fs.writeFileSync(
    'broadcast/Generation.s.sol/11155111/run-latest.json',
    JSON.stringify({ transactions, receipts })
  )
  const deployed = env.generateReleaseManifest(context) as ReleaseManifest
  assertGenerationComplete(env.releaseBase, deployed)
  assert.deepEqual(deployed.instances, [])
  assert.equal(
    env.profile.releaseManifestFile,
    generationManifestPath('v0.1.0')
  )
  const missing = structuredClone(deployed)
  missing.contracts.importedTrustgraphsFactory = {
    address: null,
    block: null,
    txHash: null,
  }
  missing.contracts.governedImportedTrustgraphsFactory = {
    address: null,
    block: null,
    txHash: null,
  }
  assert.throws(
    () => assertGenerationComplete(env.releaseBase, missing),
    /missing deployment receipt/
  )
  const wrongGuest = structuredClone(deployed)
  wrongGuest.programs.weighted.elfSha256 = `0x${'ff'.repeat(32)}`
  assert.throws(
    () => assertGenerationComplete(env.releaseBase, wrongGuest),
    /guest identities/
  )
})
