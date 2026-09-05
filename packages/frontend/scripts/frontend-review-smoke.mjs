#!/usr/bin/env node
/**
 * Build the current frontend in a disposable tree with synthetic local configuration,
 * then run the mobile/accessibility and governance browser regressions. No linked
 * deployment config is modified and no chain, wallet provider or indexer is needed.
 * Requires installed workspace dependencies and `playwright install chromium`.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import {
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  reviewAccounts,
  reviewContracts,
  startReviewFixtureServer,
} from './frontend-review-fixtures.mjs'

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = resolve(frontend, '../..')
const output = resolve(
  process.env.FRONTEND_REVIEW_OUTPUT ??
    join(repository, '.trustgraph/shots/review-smoke')
)
await mkdir(output, { recursive: true })
const scratch = await mkdtemp(join(tmpdir(), 'trustgraphs-browser-smoke-'))
const app = join(scratch, 'packages/frontend')
let nextServer
let fixture
const run = (args, env, logName) =>
  new Promise((resolve, reject) => {
    const logPath = join(output, logName)
    const log = createWriteStream(logPath)
    const child = spawn(process.execPath, args, {
      cwd: app,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.pipe(log)
    child.stderr.pipe(log)
    child.once('error', reject)
    child.once('exit', (code) => {
      log.end()
      code === 0
        ? resolve()
        : reject(
            new Error(`${basename(args[0])} exited ${code}; see ${logPath}`)
          )
    })
  })
const availablePort = async () => {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

try {
  fixture = await startReviewFixtureServer()
  await cp(frontend, app, {
    recursive: true,
    dereference: true,
    filter: (path) => {
      const parts = relative(frontend, path).split('/')
      return !parts.some(
        (part) =>
          part === 'node_modules' ||
          part === '.trustgraph' ||
          part === '.git' ||
          part.startsWith('.next') ||
          part.startsWith('.env') ||
          part.endsWith('.tsbuildinfo') ||
          part === 'config.json' ||
          part === 'networks.json' ||
          /^config\.(development|sepolia)\.json$/.test(part)
      )
    },
  })
  await symlink(
    join(frontend, 'node_modules'),
    join(app, 'node_modules'),
    'dir'
  )
  await symlink(
    join(repository, 'node_modules'),
    join(scratch, 'node_modules'),
    'dir'
  )
  await symlink(join(repository, 'docs'), join(scratch, 'docs'), 'dir')
  await mkdir(join(scratch, 'config'))
  await copyFile(
    join(repository, 'config/hidden-network-ids.json'),
    join(scratch, 'config/hidden-network-ids.json')
  )
  await copyFile(
    join(repository, 'package.json'),
    join(scratch, 'package.json')
  )
  await copyFile(
    join(repository, 'packages/indexer/ponder.schema.ts'),
    join(app, 'ponder.schema.ts')
  )
  await copyFile(
    join(repository, 'packages/indexer/offchain.schema.ts'),
    join(app, 'offchain.schema.ts')
  )
  const config = JSON.parse(
    await readFile(join(frontend, 'config.typecheck.json'), 'utf8')
  )
  config.apis.ponder = fixture.origin
  config.apis.ipfsGateway = `${fixture.origin}/ipfs/`
  config.contracts.TrustgraphsFactory = reviewContracts.factory
  config.contracts.GovernedTrustgraphsFactory = reviewContracts.governedFactory
  const networks = JSON.parse(
    await readFile(
      join(repository, 'config/networks.development.template.json'),
      'utf8'
    )
  )
  const network = networks.find(({ id }) => id === 'demo-co-op')
  assert.ok(network, 'Development catalog template must include demo-co-op')
  Object.assign(network.contracts, {
    merkleSnapshot: reviewContracts.snapshot,
    easIndexerResolver: reviewContracts.accumulator,
    merkleGovModule: reviewContracts.governor,
    merkleFundDistributor: reviewContracts.distributor,
    safe: { proxy: reviewContracts.safe },
  })
  network.pagerank.trustedSeeds = [reviewAccounts[0]]
  for (const schema of network.schemas) {
    schema.uid = `0x${'22'.repeat(32)}`
    schema.resolver = reviewContracts.accumulator
  }
  await writeFile(join(app, 'config.json'), JSON.stringify(config, null, 2))
  await writeFile(join(app, 'networks.json'), JSON.stringify(networks, null, 2))
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_TG_REVIEW_FIXTURES: '1',
    NEXT_PUBLIC_RPC_URL_31337: `${fixture.origin}/rpc`,
    NEXT_PUBLIC_WEBSOCKET_URL_31337:
      fixture.origin.replace('http:', 'ws:') + '/rpc',
    RPC_URL_1: `${fixture.origin}/rpc`,
    RPC_URL_11155111: `${fixture.origin}/rpc`,
    NEXT_DIST_DIR: '.next-review-smoke',
    NEXT_TSCONFIG_PATH: 'tsconfig.json',
    TG_FIXTURE: 'one',
    FRONTEND_REVIEW_FIXTURES: '1',
    FRONTEND_SMOKE_OUTPUT: join(output, 'accessibility'),
    GOVERNANCE_SMOKE_OUTPUT: join(output, 'governance'),
  }
  const next = join(frontend, 'node_modules/next/dist/bin/next')
  console.log(`Building isolated browser review app; logs: ${output}`)
  await run([next, 'build', '--webpack'], env, 'build.log')
  const port = await availablePort()
  const origin = `http://127.0.0.1:${port}`
  const serverLog = createWriteStream(join(output, 'server.log'))
  nextServer = spawn(
    process.execPath,
    [next, 'start', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: app,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  nextServer.stdout.pipe(serverLog)
  nextServer.stderr.pipe(serverLog)
  nextServer.once('exit', () => serverLog.end())
  const deadline = Date.now() + 60_000
  while (true) {
    if (nextServer.exitCode !== null)
      throw new Error(`Review server exited; see ${output}/server.log`)
    try {
      if ((await fetch(origin, { signal: AbortSignal.timeout(2_000) })).ok)
        break
    } catch {
      /* Wait for this owned server, never reuse a preexisting port. */
    }
    if (Date.now() > deadline)
      throw new Error('Review server did not become ready in 60 seconds')
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  const browserEnv = {
    ...env,
    FRONTEND_URL: origin,
    GOVERNANCE_FRONTEND_URL: origin,
    FRONTEND_DIST_DIR: join(app, env.NEXT_DIST_DIR),
  }
  console.log(`Isolated review server ready: ${origin} (${app})`)
  console.log('Running mobile/accessibility browser regression checks')
  await run(
    [join(app, 'scripts/frontend-accessibility-smoke.mjs')],
    browserEnv,
    'accessibility.log'
  )
  console.log('Running governance browser regression checks')
  await run(
    [join(app, 'scripts/governance-browser-smoke.mjs')],
    browserEnv,
    'governance.log'
  )
  console.log('Running production scoring worker regression checks')
  await run(
    [join(app, 'scripts/scoring-worker-smoke.mjs')],
    browserEnv,
    'scoring-worker.log'
  )
  assert.deepEqual(
    fixture.writes,
    [],
    'Browser smoke attempted a write outside its intercepted metadata request'
  )
  console.log(`Frontend review smoke passed; screenshots and logs: ${output}`)
} catch (error) {
  console.error(error.message)
  throw error
} finally {
  if (
    process.env.FRONTEND_REVIEW_KEEP_SERVER === '1' &&
    nextServer?.pid &&
    nextServer.exitCode === null
  ) {
    console.log('Keeping the isolated server available until interrupted')
    await new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
  }
  if (nextServer?.pid) {
    try {
      process.kill(-nextServer.pid, 'SIGTERM')
    } catch {
      /* Already exited. */
    }
  }
  await fixture?.close()
  await rm(scratch, { recursive: true, force: true })
}
