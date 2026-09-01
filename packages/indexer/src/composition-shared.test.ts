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
  type CompositionParamsV2,
  TRUST_GRAPH_SOURCE_OUTPUT_DOMAIN,
  TRUST_GRAPH_SOURCE_PROGRAM,
  WEIGHTED_TRUST_GRAPH_SOURCE_OUTPUT_DOMAIN,
  WEIGHTED_TRUST_GRAPH_SOURCE_PROGRAM,
  computeComposition,
  serializeCompositionAttribution,
  verifyCompositionAcceptance,
} from './composition-shared'

const production = JSON.parse(
  readFileSync(
    new URL('../../../tests/golden/trust-compose.json', import.meta.url),
    'utf8'
  )
) as any
const research = JSON.parse(
  readFileSync(
    new URL('../../../research/composition/golden.json', import.meta.url),
    'utf8'
  )
) as any
const mixed = JSON.parse(
  readFileSync(
    new URL('../../../tests/golden/trust-compose-v2.json', import.meta.url),
    'utf8'
  )
) as any
const trustGraph = JSON.parse(
  readFileSync(
    new URL('../../../tests/golden/trust-graph.json', import.meta.url),
    'utf8'
  )
) as any

const params = (): CompositionParams => ({
  version: production.params.version,
  programId: production.params.programId,
  scopeHash: production.params.scopeHash,
  identityDomain: production.params.identityDomain,
  outputKind: production.params.outputKind,
  outputDomain: production.params.outputDomain,
  admittedProgramId: production.params.admittedProgramId,
  weightScale: BigInt(production.params.weightScale),
  outputPool: BigInt(production.params.outputPool),
  sourcePolicyRoot: production.params.sourcePolicyRoot,
  sourceCount: production.params.sourceCount,
  policyManifestSha256: production.params.policyManifestSha256,
  maxSources: production.params.maxSources,
  maxEntriesPerSource: production.params.maxEntriesPerSource,
  maxAggregateEntries: production.params.maxAggregateEntries,
  maxUnionAccounts: production.params.maxUnionAccounts,
  maxAggregateBlobBytes: production.params.maxAggregateBlobBytes,
  maxSourceAgeBlocks: BigInt(production.params.maxSourceAgeBlocks),
  accumulator: production.params.accumulator,
  chainId: BigInt(production.params.chainId),
})

const sourceBlobs = [
  trustGraph.cid.blob,
  '{"0x0202020202020202020202020202020202020202":"50","0x0404040404040404040404040404040404040404":"30","0x0505050505050505050505050505050505050505":"20"}',
  '{"0x0101010101010101010101010101010101010101":"1","0x0505050505050505050505050505050505050505":"1","0x0606060606060606060606060606060606060606":"2","0x0707070707070707070707070707070707070707":"3"}',
]

const preimages = () =>
  sourceBlobs.map((blob, index) => ({
    cid: research.sourceStates[index].cid as string,
    blob: new TextEncoder().encode(blob),
  }))

const manifest = production.capture.manifest as Hex

const accepted = (): CompositionAcceptedState => ({
  programId: COMPOSITION_PROGRAM,
  outputDomain: COMPOSITION_OUTPUT_DOMAIN,
  paramsHash: production.params.paramsHash,
  captureCommitment: production.capture.manifestSha256,
  captureCount: BigInt(production.capture.count),
  outputRoot: production.output.root,
  outputBlobSha256: production.output.blobSha256,
  outputCid: production.output.cid,
  totalValue: BigInt(production.output.totalValue),
  acceptedRoot: production.output.root,
  acceptedBlobSha256: production.output.blobSha256,
  acceptedCid: production.output.cid,
  acceptedTotalValue: BigInt(production.output.totalValue),
})

test('production recompute reproduces the Rust/Solidity/TypeScript composition golden', () => {
  const result = computeComposition(params(), manifest, preimages(), 10n)
  assert.equal(result.manifestSha256, production.capture.manifestSha256)
  assert.equal(result.outputRoot, production.output.root)
  assert.equal(result.outputBlobSha256, production.output.blobSha256)
  assert.equal(result.outputCid, production.output.cid)
  assert.equal(result.totalValue, 1_000_000n)
  assert.deepEqual(
    result.sourceAllocations.map(({ sourceId, quota }) => ({
      sourceId,
      quota: quota.toString(),
    })),
    production.sourceQuotas
  )
  assert.deepEqual(result.work, {
    sourceCount: 3,
    aggregateEntries: 10,
    unionAccounts: 7,
    outputAccounts: 7,
    aggregateBlobBytes: sourceBlobs.reduce(
      (total, blob) => total + Buffer.byteLength(blob),
      0
    ),
  })
  assert.equal(result.metrics.overlapAccounts, 3)
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
        bytes[132] = bytes[132]! ^ 1
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
        bytes[23 + 132] = bytes[23 + 132]! ^ 1
        const changed = `0x${Buffer.from(bytes).toString('hex')}` as Hex
        verifyCompositionAcceptance(
          params(),
          changed,
          preimages(),
          {
            ...accepted(),
            captureCommitment: production.capture.manifestSha256,
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
          { ...accepted(), totalValue: 999_999n },
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

const mixedParams = (): CompositionParamsV2 => ({
  version: mixed.params.version,
  programId: mixed.params.programId,
  scopeHash: mixed.params.scopeHash,
  identityDomain: mixed.params.identityDomain,
  outputKind: mixed.params.outputKind,
  outputDomain: mixed.params.outputDomain,
  sourceCompatibilityClass: mixed.params.sourceCompatibilityClass,
  weightScale: BigInt(mixed.params.weightScale),
  outputPool: BigInt(mixed.params.outputPool),
  sourcePolicyRoot: mixed.params.sourcePolicyRoot,
  sourceCount: mixed.params.sourceCount,
  policyManifestSha256: mixed.params.policyManifestSha256,
  maxSources: mixed.params.maxSources,
  maxEntriesPerSource: mixed.params.maxEntriesPerSource,
  maxAggregateEntries: mixed.params.maxAggregateEntries,
  maxUnionAccounts: mixed.params.maxUnionAccounts,
  maxAggregateBlobBytes: mixed.params.maxAggregateBlobBytes,
  maxSourceAgeBlocks: BigInt(mixed.params.maxSourceAgeBlocks),
  accumulator: mixed.params.accumulator,
  chainId: BigInt(mixed.params.chainId),
})

const mixedManifest = mixed.capture.manifest as Hex

const mixedPreimages = () =>
  mixed.sourceStates.map((state: any) => ({
    cid: state.cid as string,
    blob: new TextEncoder().encode(state.blob as string),
  }))

const mixedAccepted = (): CompositionAcceptedState => ({
  programId: COMPOSITION_PROGRAM,
  outputDomain: COMPOSITION_OUTPUT_DOMAIN,
  paramsHash: mixed.params.paramsHash,
  captureCommitment: mixed.capture.manifestSha256,
  captureCount: BigInt(mixed.capture.count),
  outputRoot: mixed.output.root,
  outputBlobSha256: mixed.output.blobSha256,
  outputCid: mixed.output.cid,
  totalValue: BigInt(mixed.output.totalValue),
  acceptedRoot: mixed.output.root,
  acceptedBlobSha256: mixed.output.blobSha256,
  acceptedCid: mixed.output.cid,
  acceptedTotalValue: BigInt(mixed.output.totalValue),
})

test('the class constant matches the frozen mixed vector', () => {
  assert.equal(
    COMPOSITION_SOURCE_COMPATIBILITY_CLASS,
    mixed.constants.sourceCompatibilityClass
  )
})

test('mixed V2 recompute reproduces the frozen golden and both real source identities', () => {
  const result = computeComposition(
    mixedParams(),
    mixedManifest,
    mixedPreimages(),
    10n
  )
  assert.equal(result.manifestSha256, mixed.capture.manifestSha256)
  assert.equal(result.outputRoot, mixed.output.root)
  assert.equal(result.outputBlobSha256, mixed.output.blobSha256)
  assert.equal(result.outputCid, mixed.output.cid)
  assert.equal(result.totalValue, 1_000n)
  assert.deepEqual(
    result.sourceAllocations.map(({ sourceId, quota }) => ({
      sourceId,
      quota: quota.toString(),
    })),
    mixed.sourceQuotas
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
  verifyCompositionAcceptance(
    mixedParams(),
    mixedManifest,
    mixedPreimages(),
    mixedAccepted(),
    10n
  )
})

test('mixed V2 admission refuses crossed pairs, foreign classes, and generation replay', () => {
  const mutated = (offset: number, value: Uint8Array) => {
    const bytes = hexToBytes(mixedManifest)
    bytes.set(value, offset)
    return `0x${Buffer.from(bytes).toString('hex')}` as Hex
  }
  const record = (position: number) => 23 + position * 293

  const cases: Array<[string, () => void]> = [
    [
      'standard source borrowing the weighted domain',
      () =>
        computeComposition(
          mixedParams(),
          mutated(
            record(0) + 116,
            hexToBytes(WEIGHTED_TRUST_GRAPH_SOURCE_OUTPUT_DOMAIN)
          ),
          mixedPreimages(),
          10n
        ),
    ],
    [
      'weighted source borrowing the standard domain',
      () =>
        computeComposition(
          mixedParams(),
          mutated(
            record(1) + 116,
            hexToBytes(TRUST_GRAPH_SOURCE_OUTPUT_DOMAIN)
          ),
          mixedPreimages(),
          10n
        ),
    ],
    [
      'unknown program copying an allowed domain',
      () =>
        computeComposition(
          mixedParams(),
          mutated(record(0) + 84, new Uint8Array(32).fill(0x77)),
          mixedPreimages(),
          10n
        ),
    ],
    [
      'a foreign compatibility class',
      () =>
        computeComposition(
          {
            ...mixedParams(),
            sourceCompatibilityClass: `0x${'11'.repeat(32)}`,
          },
          mixedManifest,
          mixedPreimages(),
          10n
        ),
    ],
    [
      'V2 capture bytes replayed under a V1 tuple',
      () => computeComposition(params(), mixedManifest, mixedPreimages(), 10n),
    ],
    [
      'V1 capture bytes replayed under a V2 tuple',
      () => computeComposition(mixedParams(), manifest, preimages(), 10n),
    ],
  ]
  for (const [name, run] of cases) {
    assert.throws(run, /trust-compose verification refused/, name)
  }
})
