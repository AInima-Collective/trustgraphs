import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { loadTargetEnvironment } from '../../scripts/load-env.cjs'

const fixture = (files: Record<string, string>): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trustgraphs-env-'))
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), content)
  }
  return directory
}

test('local resolution reads only .env and cannot see Sepolia secrets', (t) => {
  const repositoryRoot = fixture({
    '.env':
      'DEPLOY_STAGE=development\nDEPLOY_TARGET=local\nRPC_URL=http://local\n',
    '.env.sepolia':
      'DEPLOY_STAGE=production\nDEPLOY_TARGET=sepolia\nRPC_URL=https://sepolia\nSEPOLIA_SECRET=private\n',
  })
  t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }))
  const environment: NodeJS.ProcessEnv = {}

  const loaded = loadTargetEnvironment({ repositoryRoot, environment })

  assert.equal(loaded.target, 'local')
  assert.equal(environment.RPC_URL, 'http://local')
  assert.equal(environment.SEPOLIA_SECRET, undefined)
})

test('a public target overlays .env while explicit variables still win', (t) => {
  const repositoryRoot = fixture({
    '.env':
      'DEPLOY_STAGE=development\nDEPLOY_TARGET=local\nRPC_URL=http://local\nSHARED=base\n',
    '.env.sepolia':
      'DEPLOY_STAGE=production\nDEPLOY_TARGET=sepolia\nRPC_URL=https://sepolia\nSEPOLIA_SECRET=private\n',
  })
  t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }))
  const environment: NodeJS.ProcessEnv = {
    DEPLOY_TARGET: 'sepolia',
    RPC_URL: 'https://explicit',
  }

  const loaded = loadTargetEnvironment({ repositoryRoot, environment })

  assert.equal(loaded.target, 'sepolia')
  assert.equal(environment.DEPLOY_STAGE, 'production')
  assert.equal(environment.RPC_URL, 'https://explicit')
  assert.equal(environment.SEPOLIA_SECRET, 'private')
  assert.equal(environment.SHARED, 'base')
})

test('a named public target fails closed without its overlay', (t) => {
  const repositoryRoot = fixture({
    '.env':
      'DEPLOY_STAGE=development\nDEPLOY_TARGET=local\nRPC_URL=http://local\n',
  })
  t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }))

  assert.throws(
    () =>
      loadTargetEnvironment({
        repositoryRoot,
        environment: { DEPLOY_TARGET: 'sepolia' },
      }),
    /Missing environment file .*\.env\.sepolia/
  )
})

test('a caller-owned local file fills values absent from the target overlay', (t) => {
  const repositoryRoot = fixture({
    '.env': 'DEPLOY_TARGET=local\nDATABASE_URL=postgresql:\/\/root\n',
    'indexer.env': 'DATABASE_URL=postgresql:\/\/indexer\n',
  })
  t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }))
  const environment: NodeJS.ProcessEnv = {}

  loadTargetEnvironment({
    repositoryRoot,
    environment,
    higherPriorityFiles: [path.join(repositoryRoot, 'indexer.env')],
  })

  assert.equal(environment.DATABASE_URL, 'postgresql://indexer')
})

test('a public overlay replaces local service settings', (t) => {
  const repositoryRoot = fixture({
    '.env': 'DEPLOY_TARGET=local\nIPFS_GATEWAY=http:\/\/local-base\n',
    '.env.sepolia':
      'DEPLOY_TARGET=sepolia\nIPFS_GATEWAY=https:\/\/public-gateway\n',
    'indexer.env':
      'IPFS_GATEWAY=http:\/\/local-indexer\nDATABASE_URL=postgresql:\/\/shared\n',
  })
  t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }))
  const environment: NodeJS.ProcessEnv = { DEPLOY_TARGET: 'sepolia' }

  loadTargetEnvironment({
    repositoryRoot,
    environment,
    higherPriorityFiles: [path.join(repositoryRoot, 'indexer.env')],
  })

  assert.equal(environment.IPFS_GATEWAY, 'https://public-gateway')
  assert.equal(environment.DATABASE_URL, 'postgresql://shared')
})

test('clean local tooling can create the base environment from the example', (t) => {
  const repositoryRoot = fixture({
    '.env.example':
      'DEPLOY_STAGE=development\nDEPLOY_TARGET=local\nRPC_URL=http://local\n',
  })
  t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }))
  const environment: NodeJS.ProcessEnv = {}

  const loaded = loadTargetEnvironment({
    repositoryRoot,
    environment,
    createBaseFrom: '.env.example',
  })

  assert.equal(loaded.target, 'local')
  assert.equal(environment.RPC_URL, 'http://local')
  assert.equal(
    fs.readFileSync(path.join(repositoryRoot, '.env'), 'utf8'),
    fs.readFileSync(path.join(repositoryRoot, '.env.example'), 'utf8')
  )
})

test('hosted processes can opt out of repository environment files', () => {
  const repositoryRoot = path.join(os.tmpdir(), 'trustgraphs-missing-env-root')
  const environment: NodeJS.ProcessEnv = {
    DEPLOY_TARGET: 'sepolia',
    PONDER_RPC_URL_11155111: 'https://rpc.example.invalid',
    TRUSTGRAPHS_ENV_FROM_PROCESS: '1',
  }

  const loaded = loadTargetEnvironment({ repositoryRoot, environment })

  assert.equal(loaded.target, 'sepolia')
  assert.deepEqual(loaded.files, [])
  assert.equal(
    loaded.environment.PONDER_RPC_URL_11155111,
    'https://rpc.example.invalid'
  )
})

test('a caller can select process-only loading and supply the default target', () => {
  const environment: NodeJS.ProcessEnv = { VERCEL: '1' }

  const loaded = loadTargetEnvironment({
    repositoryRoot: path.join(os.tmpdir(), 'trustgraphs-missing-vercel-root'),
    environment,
    target: 'sepolia',
    fromProcess: true,
  })

  assert.equal(loaded.target, 'sepolia')
  assert.equal(environment.DEPLOY_TARGET, 'sepolia')
  assert.deepEqual(loaded.files, [])
})
