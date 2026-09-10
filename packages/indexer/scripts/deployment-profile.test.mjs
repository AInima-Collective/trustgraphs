import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CHAIN_PROFILES,
  DEPLOY_TARGETS,
  loadFinalizedManifest,
  manifestContractAddresses,
  resolveDeploymentProfile,
} from './deployment-profile.mjs'

const repoRoot = path.join(import.meta.dirname, '../../..')
const readRepoManifest = (target) =>
  JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, 'deployments', `${target}.json`),
      'utf8'
    )
  )

/** Write a manifest into a throwaway repository layout and return its root. */
const temporaryRepo = (target, manifest) => {
  const repo = fs.mkdtempSync(
    path.join(os.tmpdir(), `trustgraphs-indexer-${target}-`)
  )
  fs.mkdirSync(path.join(repo, 'deployments'))
  fs.writeFileSync(
    path.join(repo, 'deployments', `${target}.json`),
    JSON.stringify(manifest)
  )
  return repo
}

/** The finalized Sepolia manifest re-bound to another public profile row. */
const syntheticCompleteManifest = (target) => {
  const manifest = structuredClone(readRepoManifest('sepolia'))
  manifest.chain = target
  manifest.chainId = CHAIN_PROFILES[target].chainId
  return manifest
}

test('the profile table is the only chain switch', () => {
  assert.deepEqual(DEPLOY_TARGETS, ['local', 'sepolia', 'mainnet'])
  for (const [target, profile] of Object.entries(CHAIN_PROFILES)) {
    assert.equal(profile.target, target)
    assert.equal(
      profile.rpcEnv,
      `PONDER_RPC_URL_${profile.chainId}`,
      `${target} rpcEnv`
    )
    assert.equal(profile.wsEnv, `PONDER_WS_URL_${profile.chainId}`)
    if (profile.public) {
      assert.equal(
        profile.startBlockEnv,
        `PONDER_START_BLOCK_${profile.chainId}`
      )
      assert.equal(profile.releaseManifestFile, `deployments/${target}.json`)
      assert.equal(profile.networksFile, `config/networks.${target}.json`)
    } else {
      assert.equal(profile.startBlockEnv, 'PONDER_START_BLOCK')
      assert.equal(profile.releaseManifestFile, undefined)
    }
  }
})

test('stage and target resolve independently', () => {
  const local = resolveDeploymentProfile({}, '/repo')
  assert.equal(local.stage, 'development')
  assert.equal(local.target, 'local')
  assert.equal(local.chainId, 31337)
  assert.equal(local.production, false)
  assert.equal(local.networksFile, '/repo/config/networks.development.json')
  assert.throws(
    () => resolveDeploymentProfile({ DEPLOY_STAGE: 'production' }, '/repo'),
    /requires DEPLOY_TARGET/
  )
  assert.throws(
    () => resolveDeploymentProfile({ DEPLOY_STAGE: 'staging' }, '/repo'),
    /development or production/
  )
  assert.throws(
    () =>
      resolveDeploymentProfile(
        { DEPLOY_STAGE: 'production', DEPLOY_TARGET: 'optimism' },
        '/repo'
      ),
    /DEPLOY_TARGET must be one of local, sepolia, mainnet/
  )
  assert.throws(
    () =>
      resolveDeploymentProfile(
        { DEPLOY_STAGE: 'development', DEPLOY_TARGET: 'mainnet' },
        '/repo'
      ),
    /Invalid deployment profile development\/mainnet/
  )
  assert.throws(
    () =>
      resolveDeploymentProfile(
        { DEPLOY_STAGE: 'production', DEPLOY_TARGET: 'local' },
        '/repo'
      ),
    /Invalid deployment profile production\/local/
  )
})

test('Sepolia consumer refuses a planned manifest', () => {
  const repo = temporaryRepo('sepolia', {
    version: 1,
    status: 'planned',
    stage: 'production',
    chain: 'sepolia',
    chainId: 11155111,
  })
  assert.throws(
    () =>
      resolveDeploymentProfile(
        { DEPLOY_STAGE: 'production', DEPLOY_TARGET: 'sepolia' },
        repo
      ),
    /finalized/
  )
  fs.rmSync(repo, { recursive: true })
})

test('mainnet consumer refuses the planned seed and accepts a complete manifest', () => {
  // The tracked seed stays `status: planned` until the mainnet generation ships; once it is
  // deployed the synthetic-complete case below is the one that describes it.
  const seed = readRepoManifest('mainnet')
  assert.equal(seed.chain, 'mainnet')
  assert.equal(seed.chainId, 1)
  if (seed.status === 'planned') {
    assert.throws(() => loadFinalizedManifest('mainnet', repoRoot), /finalized/)
    assert.throws(
      () =>
        resolveDeploymentProfile(
          { DEPLOY_STAGE: 'production', DEPLOY_TARGET: 'mainnet' },
          repoRoot
        ),
      /finalized/
    )
  }

  const planned = temporaryRepo('mainnet', {
    version: 1,
    status: 'planned',
    stage: 'production',
    chain: 'mainnet',
    chainId: 1,
  })
  assert.throws(
    () => loadFinalizedManifest('mainnet', planned),
    /deployments\/mainnet\.json must be a finalized production Ethereum Mainnet manifest/
  )
  fs.rmSync(planned, { recursive: true })

  const complete = temporaryRepo(
    'mainnet',
    syntheticCompleteManifest('mainnet')
  )
  const loaded = loadFinalizedManifest('mainnet', complete)
  assert.equal(loaded.manifest.chainId, 1)
  assert.equal(loaded.profile.name, 'Ethereum Mainnet')
  assert.equal(loaded.file, path.join(complete, 'deployments', 'mainnet.json'))

  const profile = resolveDeploymentProfile(
    { DEPLOY_TARGET: 'mainnet' },
    complete
  )
  assert.equal(profile.stage, 'production')
  assert.equal(profile.target, 'mainnet')
  assert.equal(profile.production, true)
  assert.equal(profile.chainId, 1)
  assert.equal(profile.chainName, 'Ethereum Mainnet')
  assert.equal(profile.rpcEnv, 'PONDER_RPC_URL_1')
  assert.equal(profile.wsEnv, 'PONDER_WS_URL_1')
  assert.equal(profile.startBlockEnv, 'PONDER_START_BLOCK_1')
  assert.equal(profile.defaultStartBlock, loaded.manifest.firstDeploymentBlock)
  assert.equal(profile.deploymentFile, loaded.file)
  assert.equal(
    profile.networksFile,
    path.join(complete, 'config', 'networks.mainnet.json')
  )
  assert.ok(profile.requiredCodeAddresses.length > 0)
  fs.rmSync(complete, { recursive: true })
})

test('a manifest must bind the chain its target names', () => {
  // A finalized Sepolia manifest copied to the mainnet slot is refused on chain identity alone.
  const crossed = temporaryRepo('mainnet', readRepoManifest('sepolia'))
  assert.throws(
    () => loadFinalizedManifest('mainnet', crossed),
    /chain=mainnet, chainId=1/
  )
  fs.rmSync(crossed, { recursive: true })

  const wrongId = temporaryRepo('mainnet', {
    ...syntheticCompleteManifest('mainnet'),
    chainId: 11155111,
  })
  assert.throws(() => loadFinalizedManifest('mainnet', wrongId), /finalized/)
  fs.rmSync(wrongId, { recursive: true })

  assert.throws(
    () => loadFinalizedManifest('local', repoRoot),
    /has no release manifest/
  )
  assert.throws(
    () => loadFinalizedManifest('optimism', repoRoot),
    /DEPLOY_TARGET must be one of/
  )
})

test('public consumers refuse half a fast factory generation and index a whole one', () => {
  const fastFactory = '0x5555555555555555555555555555555555555555'
  const fastGoverned = '0x6666666666666666666666666666666666666666'
  for (const target of ['sepolia', 'mainnet']) {
    const writeManifest = (mutate) => {
      const manifest = syntheticCompleteManifest(target)
      manifest.contracts.trustgraphsFactoryFast = {
        address: fastFactory,
        block: 123,
        txHash: `0x${'55'.repeat(32)}`,
      }
      manifest.contracts.governedTrustgraphsFactoryFast = {
        address: fastGoverned,
        block: 124,
        txHash: `0x${'66'.repeat(32)}`,
      }
      mutate?.(manifest)
      return temporaryRepo(target, manifest)
    }
    const environment = { DEPLOY_STAGE: 'production', DEPLOY_TARGET: target }

    const whole = writeManifest()
    const profile = resolveDeploymentProfile(environment, whole)
    assert.equal(profile.chainId, CHAIN_PROFILES[target].chainId)
    assert.ok(profile.requiredCodeAddresses.includes(fastFactory))
    assert.ok(profile.requiredCodeAddresses.includes(fastGoverned))
    fs.rmSync(whole, { recursive: true })

    const half = writeManifest((manifest) => {
      delete manifest.contracts.governedTrustgraphsFactoryFast
    })
    assert.throws(
      () => resolveDeploymentProfile(environment, half),
      new RegExp(`${CHAIN_PROFILES[target].name} fast deployment is incomplete`)
    )
    fs.rmSync(half, { recursive: true })
  }
})

test('startup checks every recorded contract with deployed code', () => {
  const first = '0x1111111111111111111111111111111111111111'
  const second = '0x2222222222222222222222222222222222222222'
  const child = '0x3333333333333333333333333333333333333333'
  assert.deepEqual(
    manifestContractAddresses({
      contracts: {
        rootVerifier: { address: first },
        newlyAddedFactory: { address: second },
        notDeployed: { address: null },
      },
      instances: [
        {
          instanceId: `0x${'44'.repeat(32)}`,
          contracts: { merkleSnapshot: child },
        },
      ],
    }),
    [first, second, child]
  )
  assert.throws(
    () =>
      manifestContractAddresses({
        chain: 'mainnet',
        contracts: { rootVerifier: { address: `0x${'0'.repeat(40)}` } },
      }),
    /Ethereum Mainnet rootVerifier must be a nonzero address/
  )
})
