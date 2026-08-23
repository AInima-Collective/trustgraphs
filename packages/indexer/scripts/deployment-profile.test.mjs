import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveDeploymentProfile } from './deployment-profile.mjs'

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
