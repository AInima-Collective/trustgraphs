import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

test('unavailable score bytes queue retries without throwing out of the root handler', () => {
  const merkle = source('./merkle.ts')
  assert.match(merkle, /ensureScoreBlobIngestion/)
  assert.match(merkle, /ponder\.on\('scoreBlobRetry:block'/)
  assert.match(merkle, /positiveIntegerEnv\('IPFS_FETCH_ATTEMPTS', 1\)/)
  assert.match(merkle, /'IPFS_RETRY_FETCH_TIMEOUT_MS',\s*2_000/)
  assert.match(merkle, /catch \(error\)[\s\S]*markScoreBlobPending/)
  assert.match(merkle, /discarded reorged score-blob job/)
  assert.match(merkle, /Indexing will continue; durable retry/)
  assert.match(
    merkle,
    /const derived = deriveAddressMerkleRows\(scores, root\)/
  )
  assert.doesNotMatch(merkle, /skipping entries/)
  assert.doesNotMatch(merkle, /Indexing is paused here/)
})

test('current APIs expose pending availability instead of serving a stale root', () => {
  const merkleApi = source('./api/merkle.ts')
  const networkApi = source('./api/network.ts')
  assert.match(merkleApi, /requireCurrentScoreBlobAvailable/)
  assert.match(networkApi, /requireCurrentScoreBlobAvailable/)
  assert.match(merkleApi, /currentScoreBlobUnavailableBody\(error\), 503/)
  assert.match(networkApi, /currentScoreBlobUnavailableBody\(error\), 503/)
  for (const api of [merkleApi, networkApi]) {
    assert.match(
      api,
      /orderBy: \(t, \{ desc \}\) => \[desc\(t\.blockNumber\), desc\(t\.timestamp\)\]/
    )
  }
})
