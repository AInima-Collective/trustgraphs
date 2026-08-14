import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { type Hex } from 'viem'

import {
  activatedStatuses,
  normalizeWeightedParams,
  replayPriorLifecycle,
  verifyWeightedManifest,
} from './weighted-prior-shared'

const golden = JSON.parse(
  readFileSync(
    new URL('../../test/golden/weighted-prior.json', import.meta.url),
    'utf8'
  )
)

const params = {
  version: golden.params.version,
  dampingFp: BigInt(golden.params.dampingFp),
  toleranceFp: BigInt(golden.params.toleranceFp),
  maxIterations: golden.params.maxIterations,
  minWeight: BigInt(golden.params.minWeight),
  maxWeight: BigInt(golden.params.maxWeight),
  priorRoot: golden.params.priorRoot as Hex,
  priorCount: golden.params.priorCount,
  manifestSha256: golden.params.manifestSha256 as Hex,
  schemaUid: golden.params.schemaUid as Hex,
  weightFieldIndex: golden.params.weightFieldIndex,
  accumulator: golden.params.accumulator,
  chainId: BigInt(golden.params.chainId),
}

test('TGWP parser and params encoder match the Rust/Solidity golden vector', () => {
  const verified = verifyWeightedManifest(golden.prior.manifest, params, 10n)
  assert.equal(verified.root, golden.prior.root)
  assert.equal(verified.digest, golden.prior.manifestSha256)
  assert.equal(verified.entries.length, 3)
  assert.equal(normalizeWeightedParams(params).hash, golden.params.paramsHash)
})

test('wrong chain, digest, root, and stale bytes fail closed', () => {
  assert.throws(
    () => verifyWeightedManifest(golden.prior.manifest, params, 1n),
    /params chain/
  )
  const stale = `${golden.prior.manifest.slice(0, -2)}00` as Hex
  assert.throws(() => verifyWeightedManifest(stale, params, 10n))
  assert.throws(() =>
    verifyWeightedManifest(
      golden.prior.manifest,
      { ...params, priorRoot: `0x${'ff'.repeat(32)}` },
      10n
    )
  )
})

test('activation supersedes only the previous active version and is replay-idempotent', () => {
  const once = activatedStatuses(
    [
      { version: 1n, status: 'active' },
      { version: 2n, status: 'pending' },
    ],
    2n
  )
  assert.deepEqual(
    once.map((row) => row.status),
    ['superseded', 'active']
  )
  assert.deepEqual(activatedStatuses(once, 2n), once)
})

test('reorg undo and reapply of proposal/activation is duplicate-free', () => {
  const canonical = [
    { kind: 'published' as const, version: 1n },
    { kind: 'proposed' as const, version: 2n },
    { kind: 'activated' as const, version: 2n },
  ]
  const beforeActivation = replayPriorLifecycle(canonical.slice(0, 2))
  assert.deepEqual(
    [...beforeActivation],
    [
      [1n, 'active'],
      [2n, 'pending'],
    ]
  )
  const reapplied = replayPriorLifecycle(canonical)
  assert.deepEqual(
    [...reapplied],
    [
      [1n, 'superseded'],
      [2n, 'active'],
    ]
  )
  assert.equal(
    reapplied.size,
    2,
    'deterministic version IDs cannot duplicate on replay'
  )
})
