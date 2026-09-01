import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { compositionSimplex, computeCompositionPreview } from './core'
import { compositionGoldenFixture } from './fixture'

// The mixed standard/weighted vector, byte-identical across every implementation.
const golden = JSON.parse(
  readFileSync(
    join(process.cwd(), '../../tests/golden/trust-compose.json'),
    'utf8'
  )
)
const config = compositionGoldenFixture()
const preview = computeCompositionPreview(config)

assert.deepEqual(
  config.sources.map((source) => source.weight.toString()),
  ['400000000000000000', '600000000000000000']
)
assert.equal(preview.policyManifest, golden.policyManifest.encoded)
assert.equal(preview.policyManifestSha256, golden.policyManifest.sha256)
assert.equal(preview.sourcePolicyRoot, golden.policyManifest.root)
assert.equal(preview.captureManifest, golden.capture.manifest)
assert.equal(preview.captureManifestSha256, golden.capture.manifestSha256)
assert.equal(preview.outputBlobSha256, golden.output.blobSha256)
assert.equal(preview.outputCid, golden.output.cid)
assert.equal(preview.outputRoot, golden.output.root)
assert.equal(preview.totalValue.toString(), golden.output.totalValue)
assert.deepEqual(
  preview.sourceAllocations.map((source) => ({
    sourceId: source.sourceId,
    quota: source.quota.toString(),
  })),
  golden.sourceQuotas
)
assert.deepEqual(
  preview.output.map((entry) => ({
    account: entry.account,
    value: entry.value.toString(),
  })),
  golden.output.entries
)

// Every rounded account contribution remains individually inspectable and adds back to the output.
for (const output of preview.output) {
  assert.equal(
    preview.attribution
      .filter((row) => row.account === output.account)
      .reduce((sum, row) => sum + row.exactValue, 0n),
    output.value
  )
}

// The decision aids stay live on the mixed fixture: every pair is compared and every
// leave-one-out run reallocates, without pinning float-derived values beyond structure.
assert.equal(preview.metrics.pairwise.length, 1)
assert.equal(preview.metrics.leaveOneOut.length, 2)
assert.ok(preview.metrics.supportCoverage > 0)
assert.ok(preview.metrics.largestShare > 0)

// The what-if simplex explores three-source compositions only; the two-source fixture yields
// no samples, and a third mixed source brings the full whole-percent enumeration back.
assert.deepEqual(compositionSimplex(config, 20), [])
const threeSources = compositionGoldenFixture()
const third = {
  ...threeSources.sources[0]!,
  instanceId: `0x${'cc'.repeat(32)}` as const,
  sourceId: `0x${'cc'.repeat(32)}` as const,
  snapshot: `0x${'c1'.repeat(20)}` as const,
  name: 'Source CC',
}
threeSources.sources = [
  { ...threeSources.sources[0]!, weight: 200_000_000_000_000_000n },
  { ...threeSources.sources[1]!, weight: 300_000_000_000_000_000n },
  { ...third, weight: 500_000_000_000_000_000n },
]
const simplex = compositionSimplex(threeSources, 20)
assert.deepEqual(
  simplex.map((sample) => sample.weights),
  [
    [20, 20, 60],
    [20, 40, 40],
    [20, 60, 20],
    [40, 20, 40],
    [40, 40, 20],
    [60, 20, 20],
  ]
)
for (const sample of simplex) {
  assert.ok(sample.topAccounts.length > 0)
}

// Admission is the closed class: an unknown program fails even with an otherwise valid structure.
assert.throws(() => {
  const crossed = compositionGoldenFixture()
  crossed.sources[0] = {
    ...crossed.sources[0]!,
    programId: `0x${'77'.repeat(32)}`,
  }
  computeCompositionPreview(crossed)
}, /not in the compatibility class/)

console.log(
  'composition frontend mixed golden, attribution, simplex, and class admission: ok'
)
