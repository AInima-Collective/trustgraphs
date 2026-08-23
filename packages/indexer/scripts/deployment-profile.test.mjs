import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveDeploymentProfile } from './deployment-profile.mjs'

test('legacy PROD remains Optimism while stage and target are independent', () => {
  const legacy = resolveDeploymentProfile({ DEPLOY_ENV: 'PROD' }, '/repo')
  assert.equal(legacy.target, 'optimism')
  assert.equal(legacy.chainId, 10)
  assert.throws(
    () => resolveDeploymentProfile({ DEPLOY_STAGE: 'production' }, '/repo'),
    /requires DEPLOY_TARGET/
  )
  assert.throws(
    () => resolveDeploymentProfile({ DEPLOY_ENV: 'staging' }, '/repo'),
    /DEV or PROD/
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
