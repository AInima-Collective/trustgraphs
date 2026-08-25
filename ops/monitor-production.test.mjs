import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const directory = path.dirname(fileURLToPath(import.meta.url))
const monitor = path.join(directory, 'monitor-production.mjs')
const instanceId = `0x${'11'.repeat(32)}`
let currentAction = {}

const runMonitor = (base, action, extraEnvironment = {}) => {
  currentAction = action
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [monitor], {
      env: {
        ...process.env,
        MONITOR_INDEXER_URL: `${base}/indexer`,
        MONITOR_OPERATOR_URL: `${base}/operator`,
        MONITOR_RPC_URL: `${base}/rpc`,
        MONITOR_INTERVAL_SECONDS: '1',
        MONITOR_INDEXER_MAX_LAG_BLOCKS: '20',
        MONITOR_OPERATOR_MAX_STALE_SECONDS: '300',
        MONITOR_STALE_ROOT_BLOCKS: '7200',
        MONITOR_REQUIRE_ROOT: 'true',
        MONITOR_ONCE: 'true',
        ...extraEnvironment,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

test('production monitor distinguishes active publication from failure and honors one-token reserves', async () => {
  const server = http.createServer(async (request, response) => {
    const sendJson = (value) => {
      const body = JSON.stringify(value)
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      })
      response.end(body)
    }
    if (request.url === '/indexer/ready' || request.url === '/operator/ready') {
      response.writeHead(200).end()
    } else if (request.url === '/indexer/metrics') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(
        'ponder_sync_block{rpc="primary",network="sepolia",chain_id="11155111"} 100\n'
      )
    } else if (request.url === '/indexer/instances?limit=200&offset=0') {
      sendJson({ instances: [{ id: instanceId }] })
    } else if (request.url === `/indexer/vault/${instanceId}`) {
      sendJson({
        funded: true,
        ethBalance: '5',
        usdcBalance: '0',
        unpaidRootsSinceLastPayment: 0,
      })
    } else if (request.url === '/operator/status') {
      sendJson({
        tick_at: Math.floor(Date.now() / 1000),
        instances: [
          {
            instance_id: instanceId,
            blocks_since_root: 1,
            action: currentAction,
          },
        ],
      })
    } else if (request.url === '/rpc') {
      sendJson({ jsonrpc: '2.0', id: 1, result: '0x64' })
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`

  try {
    const activePublish = await runMonitor(
      base,
      { action: 'publish', checkpoint_id: 7 },
      { MONITOR_MIN_VAULT_ETH_WEI: '10', MONITOR_MIN_VAULT_USDC: '0' }
    )
    assert.equal(activePublish.code, 0)
    assert.match(
      activePublish.stderr,
      /below every configured reserve threshold/
    )
    assert.doesNotMatch(activePublish.stderr, /publication failure/)

    const failedPublish = await runMonitor(base, {
      action: 'idle',
      idle: 'publication_backoff',
      checkpoint_id: 7,
    })
    assert.equal(failedPublish.code, 0)
    assert.match(failedPublish.stderr, /publication failure/)

    const healthy = await runMonitor(base, { action: 'idle', idle: 'quiet' })
    assert.equal(healthy.code, 0)
    assert.match(healthy.stdout, /monitor ok/)
    assert.equal(healthy.stderr, '')
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})
