import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { type Hex, hexToBytes } from 'viem'

import {
  COMPOSITION_OUTPUT_DOMAIN,
  COMPOSITION_PROGRAM,
  type CompositionAcceptedState,
  type CompositionParams,
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
