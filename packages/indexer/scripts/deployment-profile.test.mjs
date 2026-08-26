import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  manifestContractAddresses,
  resolveDeploymentProfile,
} from './deployment-profile.mjs'

test('stage and target resolve independently', () => {
  const local = resolveDeploymentProfile({}, '/repo')
  assert.equal(local.stage, 'development')
  assert.equal(local.target, 'local')
  assert.equal(local.chainId, 31337)
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
    /local or sepolia/
  )
})

test('Sepolia consumer refuses a planned manifest', () => {
  const repo = fs.mkdtempSync(
    path.join(os.tmpdir(), 'trustgraphs-indexer-release-')
  )
  fs.mkdirSync(path.join(repo, 'deployments'))
  fs.writeFileSync(
    path.join(repo, 'deployments', 'sepolia.json'),
    JSON.stringify({
      version: 1,
      status: 'planned',
      stage: 'production',
      chain: 'sepolia',
      chainId: 11155111,
    })
  )
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

test('Sepolia consumer refuses half a fast factory generation and indexes a whole one', () => {
  const repoManifest = JSON.parse(
    fs.readFileSync(
      path.join(import.meta.dirname, '../../../deployments/sepolia.json'),
      'utf8'
    )
  )
  const fastFactory = '0x5555555555555555555555555555555555555555'
  const fastGoverned = '0x6666666666666666666666666666666666666666'
  const writeManifest = (mutate) => {
    const manifest = structuredClone(repoManifest)
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
    const repo = fs.mkdtempSync(
      path.join(os.tmpdir(), 'trustgraphs-indexer-fast-')
    )
    fs.mkdirSync(path.join(repo, 'deployments'))
    fs.writeFileSync(
      path.join(repo, 'deployments', 'sepolia.json'),
      JSON.stringify(manifest)
    )
    return repo
  }
  const environment = { DEPLOY_STAGE: 'production', DEPLOY_TARGET: 'sepolia' }

  const whole = writeManifest()
  const profile = resolveDeploymentProfile(environment, whole)
  assert.ok(profile.requiredCodeAddresses.includes(fastFactory))
  assert.ok(profile.requiredCodeAddresses.includes(fastGoverned))
  fs.rmSync(whole, { recursive: true })

  const half = writeManifest((manifest) => {
    delete manifest.contracts.governedTrustgraphsFactoryFast
  })
  assert.throws(
    () => resolveDeploymentProfile(environment, half),
    /fast deployment is incomplete/
  )
  fs.rmSync(half, { recursive: true })
})

test('Sepolia startup checks every recorded contract with deployed code', () => {
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
})
