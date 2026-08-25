import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  manifestDeploymentSummary,
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

test('deployment summary exposes every deployed factory family', () => {
  const address = '0x1111111111111111111111111111111111111111'
  const summary = manifestDeploymentSummary({
    external: { eas: address, schemaRegistry: address },
    contracts: {
      schemaRegistrar: { address },
      instanceRegistry: { address },
      provingVault: { address },
      trustgraphsFactory: { address },
      weightedTrustgraphsFactory: { address },
      governedWeightedTrustgraphsFactory: { address },
      trustComposeFactory: { address },
      governedTrustComposeFactory: { address },
      contributionsFactory: { address },
    },
    instances: [],
  })
  assert.equal(summary.weightedFactory.weighted_factory, address)
  assert.equal(
    summary.governedWeightedFactory.governed_weighted_factory,
    address
  )
  assert.equal(summary.trustComposeFactory.trust_compose_factory, address)
  assert.equal(summary.governedComposeFactory.governed_compose_factory, address)
  assert.equal(summary.contributionsFactory.contributions_factory, address)
})
