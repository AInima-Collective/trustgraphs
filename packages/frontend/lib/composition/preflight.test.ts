import assert from 'node:assert/strict'

import type { Address, Hex } from 'viem'

import {
  type CompositionConfig,
  type CompositionSource,
  WEIGHT_SCALE,
  canonicalCompositionBlob,
  compositionOutputRoot,
  computeCompositionPreview,
} from './core'
import { compositionGoldenFixture } from './fixture'
import { COMPOSITION_TRUTH_COPY, compositionPreflight } from './preflight'
import { cidV1Raw, digestToHex, sha256Utf8 } from '../pagerank/cid'
import { ZERO_ADDRESS } from '../pagerank/words'

const codes = (config: CompositionConfig, preview = null as any) =>
  compositionPreflight({ config, preview, stage: 'preview' }).issues.map(
    (issue) => issue.code
  )

const baseline = compositionGoldenFixture()
const preview = computeCompositionPreview(baseline)
const previewCheck = compositionPreflight({
  config: baseline,
  preview,
  stage: 'preview',
})
assert.equal(previewCheck.blocked, false)
assert.ok(previewCheck.issues.some((issue) => issue.code === 'raw-point-scale'))
assert.ok(previewCheck.issues.some((issue) => issue.code === 'missing-account'))
// Two-source coverage is at least half the cells by construction, so the sparse-support
// warning (< 50%) stays quiet on the mixed baseline.
assert.ok(
  !previewCheck.issues.some((issue) => issue.code === 'sparse-support')
)
assert.match(COMPOSITION_TRUTH_COPY.prior, /separate trust-compose program/)
assert.doesNotMatch(COMPOSITION_TRUTH_COPY.weights, /objective truth/i)

const signCheck = compositionPreflight({
  config: baseline,
  preview,
  stage: 'sign',
})
assert.equal(signCheck.blocked, true)
assert.ok(
  signCheck.issues
    .filter((issue) => issue.blocks)
    .every((issue) => issue.code === 'adapter-required')
)
assert.ok(
  signCheck.issues
    .filter((issue) => issue.code === 'adapter-required')
    .every((issue) => issue.action.includes('Prepare selected sources'))
)

const unavailable = structuredClone(baseline)
unavailable.sources[0]!.available = false
unavailable.sources[0]!.availabilityError = 'gateway returned 404'
assert.ok(codes(unavailable).includes('unavailable-source'))

const stale = structuredClone(baseline)
stale.captureBlock = 1_010_000n
assert.ok(codes(stale).includes('stale-source'))

const uncontrolled = structuredClone(baseline)
uncontrolled.sources[0]!.controller = ZERO_ADDRESS as Address
assert.ok(codes(uncontrolled).includes('missing-control-provenance'))

const sameFamily = structuredClone(baseline)
sameFamily.sources[1]!.familyId = sameFamily.sources[0]!.familyId
const familyCheck = compositionPreflight({
  config: sameFamily,
  preview: null,
  stage: 'sign',
})
const familyIssue = familyCheck.issues.find(
  (issue) => issue.code === 'same-family'
)!
assert.equal(familyIssue.blocks, false)
assert.match(familyIssue.action, /unintended/)

const cloneSource = (source: CompositionSource): CompositionSource => {
  const entries = structuredClone(source.entries)
  const blob = canonicalCompositionBlob(entries)
  const digest = sha256Utf8(blob)
  return {
    ...structuredClone(source),
    instanceId: `0x${'d1'.repeat(32)}` as Hex,
    sourceId: `0x${'dd'.repeat(32)}` as Hex,
    snapshot: `0x${'d1'.repeat(20)}` as Address,
    familyId: `0x${'fd'.repeat(32)}` as Hex,
    weight: WEIGHT_SCALE / 2n,
    outputRoot: compositionOutputRoot(entries),
    blobSha256: digestToHex(digest),
    cid: cidV1Raw(digest),
    entries,
  }
}
const cloneConfig = structuredClone(baseline)
cloneConfig.sources = [
  { ...structuredClone(baseline.sources[0]!), weight: WEIGHT_SCALE / 2n },
  cloneSource(baseline.sources[0]!),
]
const clonePreview = computeCompositionPreview(cloneConfig)
const cloneCheck = compositionPreflight({
  config: cloneConfig,
  preview: clonePreview,
  stage: 'preview',
})
assert.ok(cloneCheck.issues.some((issue) => issue.code === 'clone-correlation'))

const tiny = structuredClone(baseline)
tiny.outputPool = 1n
assert.throws(() => computeCompositionPreview(tiny), /zero quota/)
assert.ok(
  compositionPreflight({
    config: tiny,
    preview: null,
    previewError:
      'a required source receives a zero quota; raise the output pool or its weight',
    stage: 'preview',
  }).issues.some((issue) => issue.code === 'zero-quota')
)

const zeroWeight = structuredClone(baseline)
zeroWeight.sources[0]!.weight = 0n
assert.ok(codes(zeroWeight).includes('zero-weight'))
assert.ok(codes(zeroWeight).includes('weight-total'))

const capped = structuredClone(baseline)
capped.bounds.maxEntriesPerSource = 2
capped.bounds.maxAggregateEntries = 5
assert.ok(codes(capped).includes('entry-cap'))

const quoteCheck = compositionPreflight({
  config: baseline,
  preview,
  stage: 'preview',
  quote: {
    available: false,
    kind: 'conservative-band',
    feeUsd: null,
    gasUsd: null,
    payableUsd: null,
    eligible: null,
    reason: 'vault not configured',
    cadence: 'Every 1,200 blocks.',
  },
})
assert.ok(quoteCheck.issues.some((issue) => issue.code === 'quote-unavailable'))
assert.ok(quoteCheck.issues.some((issue) => issue.code === 'cadence'))

console.log(
  'composition preflight truth copy, availability, family, clone, freshness, quota, and caps: ok'
)
