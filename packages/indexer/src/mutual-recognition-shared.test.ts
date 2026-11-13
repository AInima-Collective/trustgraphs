import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { type Hex } from 'viem'

import {
  normalizeMutualParams,
  verifyMutualManifest,
} from './mutual-recognition-shared'

const golden = JSON.parse(
  readFileSync(
    new URL('../../../tests/golden/mutual-recognition.json', import.meta.url),
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

test('TGMR parser and params encoder match the Rust/Solidity golden vector', () => {
  const verified = verifyMutualManifest(golden.prior.manifest, params, 10n)
  assert.equal(verified.root, golden.prior.root)
  assert.equal(verified.digest, golden.prior.manifestSha256)
  assert.equal(verified.entries.length, 3)
  assert.equal(normalizeMutualParams(params).hash, golden.params.paramsHash)
})

test('wrong chain, digest, root, and stale bytes fail closed', () => {
  assert.throws(
    () => verifyMutualManifest(golden.prior.manifest, params, 1n),
    /params chain/
  )
  const stale = `${golden.prior.manifest.slice(0, -2)}00` as Hex
  assert.throws(() => verifyMutualManifest(stale, params, 10n))
  assert.throws(() =>
    verifyMutualManifest(
      golden.prior.manifest,
      { ...params, priorRoot: `0x${'ff'.repeat(32)}` },
      10n
    )
  )
})

test('mutual gate semantics are pinned by the golden vector', () => {
  const gated = golden.mutual.gatedEdges as Array<{
    source: string
    target: string
    weight: string
  }>
  // Every gated edge has its mirror at the same weight.
  for (const edge of gated) {
    const mirror = gated.find(
      (m) => m.source === edge.target && m.target === edge.source
    )
    assert.ok(mirror, `missing mirror for ${edge.source}->${edge.target}`)
    assert.equal(mirror.weight, edge.weight)
    // Gated weight is the min of the two directed weights.
    const forward = golden.mutual.directedEdges.find(
      (d: { source: string; target: string; weight: string }) =>
        d.source === edge.source && d.target === edge.target
    )
    const reverse = golden.mutual.directedEdges.find(
      (d: { source: string; target: string; weight: string }) =>
        d.source === edge.target && d.target === edge.source
    )
    assert.equal(
      BigInt(edge.weight),
      BigInt(Math.min(Number(forward.weight), Number(reverse.weight))),
      'gated weight must be min(forward, reverse)'
    )
  }
  // The one-way a->c directed edge has no gated counterpart.
  assert.equal(
    gated.find(
      (e) =>
        e.source === '0x1111111111111111111111111111111111111111' &&
        e.target === '0x3333333333333333333333333333333333333333'
    ),
    undefined
  )
})
