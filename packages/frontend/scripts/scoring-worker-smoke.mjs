#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { chromium } from 'playwright'

const origin = process.env.FRONTEND_URL ?? 'http://127.0.0.1:3791'
const chunks = join(process.env.FRONTEND_DIST_DIR ?? '.next', 'static/chunks')
let workerPath
for (const file of await readdir(chunks)) {
  if (!file.endsWith('.js')) continue
  if (
    (await readFile(join(chunks, file), 'utf8')).includes(
      'The scoring preview failed.'
    )
  ) {
    workerPath = `/_next/static/chunks/${basename(file)}`
    break
  }
}
assert.ok(workerPath, 'Production scoring worker bundle was not emitted')
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  const result = await page.evaluate(async (path) => {
    const S = 10n ** 18n
    const addr = (n) => `0x${n.toString(16).padStart(2, '0').repeat(20)}`
    const edge = (from, to, id, time, confidence) => ({
      kind: 0,
      attester: addr(from),
      recipient: addr(to),
      uid: `0x${id.toString(16).padStart(2, '0').repeat(32)}`,
      blockTimestamp: time,
      data: `0x${'0'.repeat(64)}${confidence.toString(16).padStart(64, '0')}`,
    })
    const params = {
      dampingFp: (85n * S) / 100n,
      toleranceFp: S / 1000000n,
      maxIterations: 100,
      minWeightFp: 0n,
      maxWeightFp: 100n * S,
      trustShareFp: S,
      trustDecayFp: (80n * S) / 100n,
      trustedSeeds: [addr(1), addr(3)],
      totalPool: 10n ** 24n,
      precisionScale: S,
      schemaUid: `0x${'ab'.repeat(32)}`,
      weightFieldIndex: 1,
      accumulator: `0x${'ac'.repeat(20)}`,
      chainId: 31337n,
    }
    const run = (request) =>
      new Promise((resolve, reject) => {
        const worker = new Worker(path)
        const timer = setTimeout(() => {
          worker.terminate()
          reject(new Error('Scoring worker timed out'))
        }, 30000)
        worker.onerror = (event) => {
          clearTimeout(timer)
          worker.terminate()
          reject(new Error(event.message))
        }
        worker.onmessage = ({ data }) => {
          clearTimeout(timer)
          worker.terminate()
          if (data.error) reject(new Error(data.error))
          else resolve(data.preview)
        }
        worker.postMessage(request)
      })
    const golden = await run({
      edges: [
        edge(1, 2, 1, 100n, 50n),
        edge(2, 3, 2, 101n, 75n),
        edge(3, 1, 3, 102n, 90n),
      ],
      current: params,
      proposed: params,
    })
    const account = (n) => `0x${n.toString(16).padStart(40, '0')}`
    const manyEdges = Array.from({ length: 2000 }, (_, i) => ({
      ...edge(1, 2, 1, BigInt(100 + i), 80n),
      attester: account(i + 1),
      recipient: account(((i + 1) % 2000) + 1),
      uid: `0x${(i + 1).toString(16).padStart(64, '0')}`,
    }))
    const largeParams = {
      ...params,
      trustedSeeds: [account(1)],
      trustShareFp: (50n * S) / 100n,
    }
    let ticks = 0
    const heartbeat = setInterval(() => ticks++, 10)
    const start = performance.now()
    const large = await run({
      edges: manyEdges,
      current: largeParams,
      proposed: { ...largeParams, dampingFp: (70n * S) / 100n },
    })
    clearInterval(heartbeat)
    return {
      root: golden.currentRoot,
      unchanged: golden.unchanged,
      inputCount: golden.inputCount.toString(),
      largeCount: large.inputCount.toString(),
      nodes: large.graphNodes.length,
      heartbeatTicks: ticks,
      elapsedMs: Math.round(performance.now() - start),
    }
  }, workerPath)
  assert.equal(
    result.root,
    '0xfce3dd62ed0649524a718391dafd651189c94f7b27a7d652d2a65d6d83e722e4'
  )
  assert.equal(result.unchanged, 3)
  assert.equal(result.inputCount, '3')
  assert.equal(result.largeCount, '2000')
  assert.equal(result.nodes, 2000)
  assert.ok(
    result.heartbeatTicks > 1,
    'Main thread did not remain responsive during scoring'
  )
  console.log(JSON.stringify(result))
} finally {
  await browser.close()
}
