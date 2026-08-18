import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { compositionSimplex, computeCompositionPreview } from './core'
import { compositionGoldenFixture } from './fixture'

const research = JSON.parse(
  readFileSync(
    join(process.cwd(), '../research/composition/golden.json'),
    'utf8'
  )
)
const production = JSON.parse(
  readFileSync(join(process.cwd(), '../test/golden/trust-compose.json'), 'utf8')
)
const config = compositionGoldenFixture()
const preview = computeCompositionPreview(config)

assert.deepEqual(
  config.sources.map((source) => source.weight.toString()),
  ['333000000000000000', '333000000000000000', '334000000000000000']
)
assert.equal(preview.policyManifest, production.policyManifest.encoded)
assert.equal(preview.policyManifestSha256, production.policyManifest.sha256)
assert.equal(preview.sourcePolicyRoot, production.policyManifest.root)
assert.equal(preview.captureManifest, production.capture.manifest)
assert.equal(preview.captureManifestSha256, research.manifestSha256)
assert.equal(preview.outputBlobSha256, research.outputBlobSha256)
assert.equal(preview.outputCid, research.outputCid)
assert.equal(preview.outputRoot, research.outputRoot)
assert.equal(preview.totalValue.toString(), research.totalValue)

assert.deepEqual(
  Object.fromEntries(
    preview.sourceAllocations.map((source) => [
      source.sourceId,
      source.quota.toString(),
    ])
  ),
  research.sourceQuotas
)
assert.deepEqual(
  Object.fromEntries(
    preview.sourceAllocations.map((source) => [
      source.sourceId,
      Object.fromEntries(
        source.entries.map((entry) => [entry.account, entry.value.toString()])
      ),
    ])
  ),
  research.sourceAllocations
)
assert.deepEqual(
  Object.fromEntries(
    preview.output.map((entry) => [entry.account, entry.value.toString()])
  ),
  research.output
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
assert.deepEqual(
  preview.metrics.pairwise.map((pair) => pair.disagreement),
  [0.6998103996207993, 0.8571428571428571, 0.8571428571428571]
)
assert.deepEqual(
  preview.metrics.leaveOneOut.map((row) => row.disagreement),
  [0.226053, 0.25927100000000003, 0.263858]
)
assert.equal(preview.metrics.supportCoverage, 10 / 21)
assert.equal(preview.metrics.largestShare, 0.266463)
assert.equal(preview.metrics.hhi, 0.16380977629600002)

const simplex = compositionSimplex(config, 20)
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
assert.deepEqual(
  simplex.map((sample) => sample.topAccounts[0]),
  [
    '0x0707070707070707070707070707070707070707',
    '0x0202020202020202020202020202020202020202',
    '0x0202020202020202020202020202020202020202',
    '0x0202020202020202020202020202020202020202',
    '0x0202020202020202020202020202020202020202',
    '0x0303030303030303030303030303030303030303',
  ]
)
assert.ok(simplex.every((sample) => sample.changedTopAccounts.length > 0))

console.log(
  'composition frontend exact golden, attribution, disagreement, and A/B/C simplex: ok'
)
