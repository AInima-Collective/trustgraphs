import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { type Hex, hexToBytes } from 'viem'

import {
  COMPOSITION_OUTPUT_DOMAIN,
  COMPOSITION_PROGRAM,
  COMPOSITION_SOURCE_COMPATIBILITY_CLASS,
  type CompositionAcceptedState,
  type CompositionParams,
  TRUST_GRAPH_SOURCE_OUTPUT_DOMAIN,
  TRUST_GRAPH_SOURCE_PROGRAM,
  WEIGHTED_TRUST_GRAPH_SOURCE_OUTPUT_DOMAIN,
  WEIGHTED_TRUST_GRAPH_SOURCE_PROGRAM,
  computeComposition,
  serializeCompositionAttribution,
  verifyCompositionAcceptance,
} from './composition-shared'

const golden = JSON.parse(
  readFileSync(
    new URL('../../../tests/golden/trust-compose.json', import.meta.url),
    'utf8'
  )
) as any

const params = (): CompositionParams => ({
  version: golden.params.version,
  programId: golden.params.programId,
  scopeHash: golden.params.scopeHash,
  identityDomain: golden.params.identityDomain,
  outputKind: golden.params.outputKind,
  outputDomain: golden.params.outputDomain,
  sourceCompatibilityClass: golden.params.sourceCompatibilityClass,
  weightScale: BigInt(golden.params.weightScale),
  outputPool: BigInt(golden.params.outputPool),
  sourcePolicyRoot: golden.params.sourcePolicyRoot,
  sourceCount: golden.params.sourceCount,
  policyManifestSha256: golden.params.policyManifestSha256,
  maxSources: golden.params.maxSources,
  maxEntriesPerSource: golden.params.maxEntriesPerSource,
  maxAggregateEntries: golden.params.maxAggregateEntries,
  maxUnionAccounts: golden.params.maxUnionAccounts,
  maxAggregateBlobBytes: golden.params.maxAggregateBlobBytes,
  maxSourceAgeBlocks: BigInt(golden.params.maxSourceAgeBlocks),
  accumulator: golden.params.accumulator,
  chainId: BigInt(golden.params.chainId),
})

const manifest = golden.capture.manifest as Hex

const preimages = () =>
  golden.sourceStates.map((state: any) => ({
    cid: state.cid as string,
    blob: new TextEncoder().encode(state.blob as string),
  }))

const accepted = (): CompositionAcceptedState => ({
  programId: COMPOSITION_PROGRAM,
  outputDomain: COMPOSITION_OUTPUT_DOMAIN,
  paramsHash: golden.params.paramsHash,
  captureCommitment: golden.capture.manifestSha256,
  captureCount: BigInt(golden.capture.count),
  outputRoot: golden.output.root,
  outputBlobSha256: golden.output.blobSha256,
  outputCid: golden.output.cid,
  totalValue: BigInt(golden.output.totalValue),
  acceptedRoot: golden.output.root,
  acceptedBlobSha256: golden.output.blobSha256,
  acceptedCid: golden.output.cid,
  acceptedTotalValue: BigInt(golden.output.totalValue),
})

test('the class constant matches the frozen mixed vector', () => {
  assert.equal(
    COMPOSITION_SOURCE_COMPATIBILITY_CLASS,
    golden.constants.sourceCompatibilityClass
  )
})

test('recompute reproduces the frozen golden and both real source identities', () => {
  const result = computeComposition(params(), manifest, preimages(), 10n)
  assert.equal(result.manifestSha256, golden.capture.manifestSha256)
  assert.equal(result.outputRoot, golden.output.root)
  assert.equal(result.outputBlobSha256, golden.output.blobSha256)
  assert.equal(result.outputCid, golden.output.cid)
  assert.equal(result.totalValue, 1_000n)
  assert.deepEqual(
    result.sourceAllocations.map(({ sourceId, quota }) => ({
      sourceId,
      quota: quota.toString(),
    })),
    golden.sourceQuotas
  )
  assert.equal(result.sources[0]!.programId, TRUST_GRAPH_SOURCE_PROGRAM)
  assert.equal(
    result.sources[0]!.sourceOutputDomain,
    TRUST_GRAPH_SOURCE_OUTPUT_DOMAIN
  )
  assert.equal(
    result.sources[1]!.programId,
    WEIGHTED_TRUST_GRAPH_SOURCE_PROGRAM
  )
  assert.equal(
    result.sources[1]!.sourceOutputDomain,
    WEIGHTED_TRUST_GRAPH_SOURCE_OUTPUT_DOMAIN
  )
  assert.equal(result.work.sourceCount, 2)
})

test('the acceptance verifier refuses every composition commitment boundary', () => {
  const goodResult = verifyCompositionAcceptance(
    params(),
    manifest,
    preimages(),
    accepted(),
    10n
  )
  const attribution = serializeCompositionAttribution(goodResult)

  const cases: Array<[string, () => void]> = [
    [
      'program',
      () =>
        verifyCompositionAcceptance(
          params(),
          manifest,
          preimages(),
          { ...accepted(), programId: `0x${'11'.repeat(32)}` },
          10n
        ),
    ],
    [
      'output domain',
      () =>
        verifyCompositionAcceptance(
          params(),
          manifest,
          preimages(),
          { ...accepted(), outputDomain: `0x${'22'.repeat(32)}` },
          10n
        ),
    ],
    [
      'params hash',
      () =>
        verifyCompositionAcceptance(
          params(),
          manifest,
          preimages(),
          { ...accepted(), paramsHash: `0x${'33'.repeat(32)}` },
          10n
        ),
    ],
    [
      'capture manifest',
      () => {
        const bytes = hexToBytes(manifest)
        bytes[23 + 164] = bytes[23 + 164]! ^ 1
        verifyCompositionAcceptance(
          params(),
          `0x${Buffer.from(bytes).toString('hex')}`,
          preimages(),
          accepted(),
          10n
        )
      },
    ],
    [
      'source blob',
      () => {
        const sources = preimages()
        sources[0]!.blob[40] = sources[0]!.blob[40]! ^ 1
        verifyCompositionAcceptance(
          params(),
          manifest,
          sources,
          accepted(),
          10n
        )
      },
    ],
    [
      'source root',
      () => {
        const bytes = hexToBytes(manifest)
        bytes[23 + 164] = bytes[23 + 164]! ^ 1
        const changed = `0x${Buffer.from(bytes).toString('hex')}` as Hex
        verifyCompositionAcceptance(
          params(),
          changed,
          preimages(),
          {
            ...accepted(),
            captureCommitment: golden.capture.manifestSha256,
          },
          10n
        )
      },
    ],
    [
      'output root',
      () =>
        verifyCompositionAcceptance(
          params(),
          manifest,
          preimages(),
          { ...accepted(), outputRoot: `0x${'44'.repeat(32)}` },
          10n
        ),
    ],
    [
      'output blob',
      () =>
        verifyCompositionAcceptance(
          params(),
          manifest,
          preimages(),
          { ...accepted(), outputBlobSha256: `0x${'55'.repeat(32)}` },
          10n
        ),
    ],
    [
      'output total',
      () =>
        verifyCompositionAcceptance(
          params(),
          manifest,
          preimages(),
          { ...accepted(), totalValue: 999n },
          10n
        ),
    ],
    [
      'accepted state',
      () =>
        verifyCompositionAcceptance(
          params(),
          manifest,
          preimages(),
          { ...accepted(), acceptedCid: 'bafk-wrong' },
          10n
        ),
    ],
    [
      'attribution',
      () =>
        verifyCompositionAcceptance(
          params(),
          manifest,
          preimages(),
          accepted(),
          10n,
          `${attribution}tampered`
        ),
    ],
  ]
  for (const [name, run] of cases) {
    assert.throws(run, /trust-compose verification refused/, name)
  }
})

test('admission refuses crossed pairs, foreign classes, and foreign version words', () => {
  const mutated = (offset: number, value: Uint8Array) => {
    const bytes = hexToBytes(manifest)
    bytes.set(value, offset)
    return `0x${Buffer.from(bytes).toString('hex')}` as Hex
  }
  const record = (position: number) => 23 + position * 293

  const cases: Array<[string, () => void]> = [
    [
      'standard source borrowing the weighted domain',
      () =>
        computeComposition(
          params(),
          mutated(
            record(0) + 116,
            hexToBytes(WEIGHTED_TRUST_GRAPH_SOURCE_OUTPUT_DOMAIN)
          ),
          preimages(),
          10n
        ),
    ],
    [
      'weighted source borrowing the standard domain',
      () =>
        computeComposition(
          params(),
          mutated(
            record(1) + 116,
            hexToBytes(TRUST_GRAPH_SOURCE_OUTPUT_DOMAIN)
          ),
          preimages(),
          10n
        ),
    ],
    [
      'unknown program copying an allowed domain',
      () =>
        computeComposition(
          params(),
          mutated(record(0) + 84, new Uint8Array(32).fill(0x77)),
          preimages(),
          10n
        ),
    ],
    [
      'a foreign compatibility class',
      () =>
        computeComposition(
          {
            ...params(),
            sourceCompatibilityClass: `0x${'11'.repeat(32)}`,
          },
          manifest,
          preimages(),
          10n
        ),
    ],
    [
      'a foreign params version word',
      () =>
        computeComposition(
          { ...params(), version: 2 },
          manifest,
          preimages(),
          10n
        ),
    ],
    [
      'a foreign capture version word',
      () =>
        computeComposition(
          params(),
          mutated(5, Uint8Array.from([2])),
          preimages(),
          10n
        ),
    ],
  ]
  for (const [name, run] of cases) {
    assert.throws(run, /trust-compose verification refused/, name)
  }
})
