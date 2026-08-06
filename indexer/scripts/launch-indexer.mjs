import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'
import pg from 'pg'

import {
  localSchemaName,
  parseRpcQuantity,
  parseStartBlock,
  sameChainIdentity,
  toBlockTag,
} from './chain-identity.mjs'

const { Client } = pg
const indexerDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repoDir = path.dirname(indexerDir)
const mode = process.argv[2]

if (!['dev', 'start', 'serve', 'preflight'].includes(mode)) {
  throw new Error(
    'Usage: node scripts/launch-indexer.mjs <dev|start|serve|preflight>'
  )
}

// Explicit process variables win, then indexer-local settings, then repository deployment values.
dotenv.config({ path: path.join(indexerDir, '.env.local'), quiet: true })
dotenv.config({ path: path.join(repoDir, '.env'), quiet: true })

const deployment = process.env.DEPLOY_ENV?.trim().toUpperCase()
if (deployment !== 'DEV' && deployment !== 'PROD') {
  throw new Error('DEPLOY_ENV must be DEV or PROD')
}
const production = deployment === 'PROD'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const viewsSchema =
  process.env.PONDER_VIEWS_SCHEMA ??
  process.env.DATABASE_VIEWS_SCHEMA ??
  'trust-graph'
const configuredProductionSchema =
  process.env.PONDER_DATABASE_SCHEMA ?? process.env.DATABASE_SCHEMA

const rpcUrl = production
  ? process.env.PONDER_RPC_URL_10
  : (process.env.PONDER_RPC_URL_31337 ??
    process.env.PONDER_RPC_URL ??
    process.env.RPC_URL ??
    'http://127.0.0.1:8545')

if (!rpcUrl) {
  throw new Error(
    production
      ? 'PONDER_RPC_URL_10 is required in production'
      : 'No local RPC URL is configured'
  )
}

const expectedChainId = production ? 10 : 31337
const startBlock = production
  ? parseStartBlock(
      process.env.PONDER_START_BLOCK_10,
      142_786_328,
      'PONDER_START_BLOCK_10'
    )
  : parseStartBlock(process.env.PONDER_START_BLOCK, 1, 'PONDER_START_BLOCK')

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(entryPath) : [entryPath]
  })
}

/**
 * Ponder will not attach an app build to a schema owned by a different build. Keep that safety
 * property, but make local upgrades automatic by deriving a fresh disposable schema name whenever
 * the inputs to the Ponder app change. Production upgrades remain explicit and versioned.
 */
function indexerAppFingerprint() {
  const files = [
    path.join(indexerDir, 'package.json'),
    path.join(indexerDir, 'ponder.config.ts'),
    path.join(indexerDir, 'ponder.schema.ts'),
    path.join(indexerDir, 'offchain.schema.ts'),
    path.join(indexerDir, 'config', 'networks.json'),
    path.join(repoDir, 'pnpm-lock.yaml'),
    path.join(repoDir, '.docker', 'deployment_summary.json'),
    path.join(repoDir, 'frontend', 'lib', 'contract-abis.ts'),
    path.join(repoDir, 'frontend', 'lib', 'pagerank', 'merkle.ts'),
    ...filesUnder(path.join(indexerDir, 'abis')),
    ...filesUnder(path.join(indexerDir, 'src')),
  ]
    .filter((file) => fs.existsSync(file))
    .sort()

  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(path.relative(repoDir, file))
    hash.update('\0')
    hash.update(fs.readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

const appFingerprint = indexerAppFingerprint()

async function rpc(method, params = []) {
  let response
  try {
    response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    throw new Error(
      `RPC preflight could not reach the configured endpoint: ${error.message}`
    )
  }

  if (!response.ok) {
    throw new Error(`RPC preflight received HTTP ${response.status}`)
  }
  const body = await response.json()
  if (body.error) {
    const detail = body.error.message ?? JSON.stringify(body.error)
    throw new Error(`${method} failed during RPC preflight: ${detail}`)
  }
  return body.result
}

async function blockAt(blockNumber) {
  const block = await rpc('eth_getBlockByNumber', [
    toBlockTag(blockNumber),
    false,
  ])
  if (!block?.hash) return undefined
  return {
    number: parseRpcQuantity(block.number, 'block number'),
    hash: block.hash,
  }
}

function deploymentAddresses() {
  const summaryPath = path.join(repoDir, '.docker', 'deployment_summary.json')
  if (!fs.existsSync(summaryPath)) {
    throw new Error(
      `Missing ${summaryPath}. Deploy contracts before starting the indexer.`
    )
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
  const addresses = new Set()
  const add = (value) => {
    if (
      typeof value === 'string' &&
      /^0x[0-9a-f]{40}$/i.test(value) &&
      !/^0x0{40}$/i.test(value)
    ) {
      addresses.add(value)
    }
  }

  add(summary.provingVault)
  add(summary.factory?.factory)
  add(summary.factory?.instance_registry)
  for (const network of summary.networks ?? []) {
    const contracts = network.contracts ?? {}
    for (const key of [
      'merkleSnapshot',
      'easIndexerResolver',
      'merkleFundDistributor',
      'merkleGovModule',
      'anchorRegistry',
      'contributionResolver',
      'poolToken',
    ]) {
      add(contracts[key])
    }
    add(contracts.safe?.proxy)
  }
  return [...addresses]
}

async function rpcPreflight() {
  const chainId = parseRpcQuantity(await rpc('eth_chainId'), 'chain id')
  if (chainId !== expectedChainId) {
    throw new Error(
      `RPC chain id is ${chainId}, expected ${expectedChainId} for DEPLOY_ENV=${deployment}`
    )
  }

  const latest = await rpc('eth_getBlockByNumber', ['latest', false])
  if (!latest?.hash) throw new Error('RPC returned no latest block')
  const head = {
    number: parseRpcQuantity(latest.number, 'latest block number'),
    hash: latest.hash,
  }
  if (head.number < startBlock) {
    throw new Error(
      `RPC head is ${head.number}, before configured start block ${startBlock}. Deploy first or correct the start block.`
    )
  }

  // This is the capability Ponder needs for deterministic event-time contract reads. A snapshot-
  // loaded or pruned Anvil can report a high head while rejecting exactly these calls.
  try {
    await rpc('eth_getBalance', [
      '0x0000000000000000000000000000000000000000',
      toBlockTag(startBlock),
    ])
  } catch (error) {
    throw new Error(
      `RPC cannot serve historical state at start block ${startBlock}. Ponder will fail on event-time eth_call requests (the reported BlockOutOfRangeError). ` +
        `Use a chain/RPC that retains history. Only raise the start block if every indexed deployment and event is newer than it. Cause: ${error.message}`
    )
  }

  const missingCode = []
  for (const address of deploymentAddresses()) {
    const code = await rpc('eth_getCode', [address, 'latest'])
    if (code === '0x' || code === '0x0') missingCode.push(address)
  }
  if (missingCode.length > 0) {
    throw new Error(
      `Deployment summary does not match this chain; no code at ${missingCode.slice(0, 4).join(', ')}${missingCode.length > 4 ? ` (+${missingCode.length - 4} more)` : ''}. Redeploy/regenerate .docker/deployment_summary.json before indexing.`
    )
  }

  return { chainId, head }
}

function assertSafeSchemaName(schema) {
  if (!/^[a-z][a-z0-9_-]{0,44}$/i.test(schema)) {
    throw new Error(`Unsafe or invalid database schema name: ${schema}`)
  }
}

const quoteIdentifier = (identifier) => {
  assertSafeSchemaName(identifier)
  return `"${identifier.replaceAll('"', '""')}"`
}

async function prepareDatabase({ chainId, head }) {
  if (production && !configuredProductionSchema) {
    throw new Error(
      'PONDER_DATABASE_SCHEMA is required in production (use a new versioned schema for each deploy)'
    )
  }

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [
      'trustgraph-indexer-lifecycle',
    ])
    await client.query('CREATE SCHEMA IF NOT EXISTS trustgraph_meta')
    await client.query(`
      CREATE TABLE IF NOT EXISTS trustgraph_meta.indexer_chain (
        environment text PRIMARY KEY,
        chain_id bigint NOT NULL,
        anchor_block bigint NOT NULL,
        anchor_hash text NOT NULL,
        index_schema text NOT NULL,
        app_fingerprint text,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await client.query(
      'ALTER TABLE trustgraph_meta.indexer_chain ADD COLUMN IF NOT EXISTS app_fingerprint text'
    )

    const environment = production ? `prod-${chainId}` : `dev-${chainId}`
    const result = await client.query(
      'SELECT chain_id, anchor_block, anchor_hash, index_schema, app_fingerprint FROM trustgraph_meta.indexer_chain WHERE environment = $1',
      [environment]
    )
    const stored = result.rows[0]
    let recordedBlock
    if (stored) {
      try {
        recordedBlock = await blockAt(Number(stored.anchor_block))
      } catch {
        recordedBlock = undefined
      }
    }
    const identityMatches =
      stored !== undefined &&
      Number(stored.chain_id) === chainId &&
      recordedBlock !== undefined &&
      sameChainIdentity(stored, recordedBlock)

    if (production && stored && !identityMatches) {
      throw new Error(
        `Production chain identity changed at recorded block ${stored.anchor_block}. Refusing to delete or reuse indexed data automatically. Verify the RPC and database, then choose a new PONDER_DATABASE_SCHEMA.`
      )
    }

    let indexSchema = configuredProductionSchema
    if (!production) {
      const appMatches =
        identityMatches && stored.app_fingerprint === appFingerprint
      indexSchema = appMatches
        ? stored.index_schema
        : localSchemaName(chainId, head, appFingerprint)

      // First adoption also resets the legacy, chain-id-only cache. All three schemas contain only
      // data derived from the local chain and are deliberately disposable.
      if (!identityMatches) {
        const reason = stored
          ? 'local chain identity changed'
          : 'initial lifecycle adoption'
        console.warn(`indexer: ${reason}; resetting derived local index state`)
        await client.query('DROP SCHEMA IF EXISTS ponder_sync CASCADE')
        await client.query('DROP SCHEMA IF EXISTS offchain CASCADE')
        await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE')
        if (stored?.index_schema) {
          await client.query(
            `DROP SCHEMA IF EXISTS ${quoteIdentifier(stored.index_schema)} CASCADE`
          )
        }
      } else if (!appMatches) {
        console.warn(
          'indexer: local indexer build changed; rebuilding derived application state'
        )
        await client.query('DROP SCHEMA IF EXISTS offchain CASCADE')
        await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE')
        await client.query(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(stored.index_schema)} CASCADE`
        )
      }
    }
    assertSafeSchemaName(indexSchema)

    // Local chains use the latest block because it captures this Anvil incarnation's deployments.
    // Production records a final block to avoid treating a shallow reorg as a different chain.
    const anchorNumber = production
      ? Math.max(startBlock, head.number - 128)
      : head.number
    const anchor =
      anchorNumber === head.number ? head : await blockAt(anchorNumber)
    if (!anchor)
      throw new Error(`Unable to read identity anchor block ${anchorNumber}`)

    await client.query(
      `INSERT INTO trustgraph_meta.indexer_chain
        (environment, chain_id, anchor_block, anchor_hash, index_schema, app_fingerprint, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (environment) DO UPDATE SET
         chain_id = excluded.chain_id,
         anchor_block = excluded.anchor_block,
         anchor_hash = excluded.anchor_hash,
         index_schema = excluded.index_schema,
         app_fingerprint = excluded.app_fingerprint,
         updated_at = now()`,
      [
        environment,
        chainId,
        anchor.number,
        anchor.hash,
        indexSchema,
        appFingerprint,
      ]
    )
    return indexSchema
  } finally {
    await client
      .query('SELECT pg_advisory_unlock(hashtext($1))', [
        'trustgraph-indexer-lifecycle',
      ])
      .catch(() => undefined)
    await client.end()
  }
}

async function run(command, args, env) {
  const child = spawn(command, args, {
    cwd: indexerDir,
    env,
    stdio: 'inherit',
  })
  let forwardedSignal
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      forwardedSignal = signal
      child.kill(signal)
    })
  }
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  if (exit.signal && exit.signal === forwardedSignal) return
  if (exit.signal) throw new Error(`${command} exited from ${exit.signal}`)
  if (exit.code !== 0)
    throw new Error(`${command} exited with code ${exit.code}`)
}

async function main() {
  if (mode === 'serve') {
    assertSafeSchemaName(viewsSchema)
    const port = process.env.PONDER_HTTP_PORT ?? '65421'
    await run(
      'pnpm',
      ['exec', 'ponder', 'serve', '--schema', viewsSchema, '--port', port],
      process.env
    )
    return
  }

  const chain = await rpcPreflight()
  const indexSchema = await prepareDatabase(chain)
  const childEnv = {
    ...process.env,
    DATABASE_SCHEMA: indexSchema,
    DATABASE_VIEWS_SCHEMA: viewsSchema,
  }

  await run('pnpm', ['run', 'db:migrate'], childEnv)
  console.log(
    `indexer: preflight passed (chain ${chain.chainId}, head ${chain.head.number}, schema ${indexSchema})`
  )
  if (mode === 'preflight') return

  const port = process.env.PONDER_PORT ?? '65421'
  const args = ['exec', 'ponder', mode, '--port', port]
  if (mode === 'start') {
    args.push('--schema', indexSchema, '--views-schema', viewsSchema)
  }
  await run('pnpm', args, childEnv)
}

main().catch((error) => {
  console.error(`indexer: startup failed: ${error.message}`)
  process.exitCode = 1
})
