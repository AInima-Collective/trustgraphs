import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const repository = path.resolve(import.meta.dirname, '../../..')
const frontend = path.join(repository, 'packages/frontend')
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')

// Everything generated here stays in an isolated temporary checkout. The synthetic
// mainnet manifest checks routing only; it is not evidence of any live deployment.
const fixture = () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'trustgraphs-config-test-')
  )
  const app = path.join(root, 'packages/frontend')
  for (const relative of [
    'scripts/load-env.cjs',
    'contracts/deploy/release-manifest.ts',
    'contracts/deploy/types.ts',
    'packages/frontend/scripts/generate-config.ts',
    'packages/frontend/scripts/link-deployment-config.mjs',
    'packages/frontend/lib/application-chains.ts',
    'packages/frontend/lib/application-targets.json',
  ]) {
    const destination = path.join(root, relative)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(path.join(repository, relative), destination)
  }
  fs.symlinkSync(
    path.join(repository, 'node_modules'),
    path.join(root, 'node_modules')
  )
  fs.symlinkSync(
    path.join(frontend, 'node_modules'),
    path.join(app, 'node_modules')
  )
  fs.mkdirSync(path.join(app, 'abis'))
  for (const name of fs.readdirSync(path.join(frontend, 'abis')))
    if (name.endsWith('.json'))
      fs.writeFileSync(path.join(app, 'abis', name), '[]')
  fs.mkdirSync(path.join(root, 'deployments'))
  fs.mkdirSync(path.join(root, 'config'))
  fs.mkdirSync(path.join(root, '.docker'))
  // A public build must never parse local deployment artifacts.
  fs.writeFileSync(
    path.join(root, '.docker/factory_deploy.json'),
    'invalid local artifact'
  )
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repository, 'deployments/sepolia.json'), 'utf8')
  )
  manifest.chain = 'mainnet'
  manifest.chainId = 1
  manifest.contracts.trustgraphsFactory.address =
    '0x1111111111111111111111111111111111111111'
  fs.writeFileSync(
    path.join(root, 'deployments/mainnet.json'),
    JSON.stringify(manifest)
  )
  fs.writeFileSync(path.join(root, 'config/networks.mainnet.json'), '[]')
  fs.writeFileSync(
    path.join(root, 'config/networks.development.template.json'),
    '[]'
  )
  fs.writeFileSync(path.join(app, 'config.typecheck.json'), '{"chain":"local"}')
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    TRUSTGRAPHS_ENV_FROM_PROCESS: '1',
    DEPLOY_TARGET: 'mainnet',
    DEPLOY_STAGE: 'production',
    RPC_URL_1_0: 'http://127.0.0.1:18545',
    RPC_URL_1_1: 'http://127.0.0.1:28545',
    PONDER_URL: 'http://127.0.0.1:16542',
    IPFS_GATEWAY_PUBLIC: 'http://127.0.0.1:18080/ipfs/',
  }
  return {
    root,
    app,
    manifest,
    generate: (overrides = {}) =>
      spawnSync(
        process.execPath,
        [tsxCli, path.join(app, 'scripts/generate-config.ts')],
        { env: { ...environment, ...overrides }, encoding: 'utf8' }
      ),
    link: (kind: 'config' | 'networks') =>
      spawnSync(
        process.execPath,
        [
          path.join(app, 'scripts/link-deployment-config.mjs'),
          kind,
          '--allow-typecheck-template',
        ],
        { env: environment, encoding: 'utf8' }
      ),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

test('mainnet generation and linking use chain 1 manifest and seed files only', () => {
  const f = fixture()
  try {
    const generated = f.generate()
    assert.equal(generated.status, 0, generated.stderr)
    const config = JSON.parse(
      fs.readFileSync(path.join(f.app, 'config.mainnet.json'), 'utf8')
    )
    assert.equal(config.chain, 'mainnet')
    assert.equal(
      config.contracts.TrustgraphsFactory,
      f.manifest.contracts.trustgraphsFactory.address
    )
    assert.equal(fs.existsSync(path.join(f.app, 'config.sepolia.json')), false)
    for (const kind of ['config', 'networks'] as const) {
      const linked = f.link(kind)
      assert.equal(linked.status, 0, linked.stderr)
      assert.match(
        fs.readlinkSync(path.join(f.app, `${kind}.json`)),
        new RegExp(`${kind}\\.mainnet\\.json$`)
      )
    }
  } finally {
    f.cleanup()
  }
})

test('public config fails closed for missing manifest, wrong chain binding, or missing chain RPC', () => {
  const f = fixture()
  try {
    const missingRpc = f.generate({ RPC_URL_1_1: '' })
    assert.notEqual(missingRpc.status, 0)
    assert.match(missingRpc.stderr, /RPC_URL_1_1 is required/)
    f.manifest.chainId = 11155111
    fs.writeFileSync(
      path.join(f.root, 'deployments/mainnet.json'),
      JSON.stringify(f.manifest)
    )
    assert.notEqual(f.generate().status, 0)
    fs.unlinkSync(path.join(f.root, 'deployments/mainnet.json'))
    assert.notEqual(f.generate().status, 0)
    assert.equal(fs.existsSync(path.join(f.app, 'config.mainnet.json')), false)
    // A local typecheck template is never a fallback for a missing public configuration.
    assert.notEqual(f.link('config').status, 0)
    assert.equal(fs.existsSync(path.join(f.app, 'config.json')), false)
  } finally {
    f.cleanup()
  }
})
