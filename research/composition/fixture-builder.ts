import { keccak256, stringToHex, type Hex } from 'viem'

import {
  COMPOSITION_VERSION,
  V1_RESEARCH_BOUNDS,
  WEIGHT_SCALE,
  canonicalScoreBlob,
  compose,
  sourceFromBlob,
  type CompositionPolicy,
} from './reference'

const address = (byte: string) => `0x${byte.repeat(20)}` as Hex
const word = (byte: string) => `0x${byte.repeat(32)}` as Hex

export const programId = keccak256(
  stringToHex('trustgraph-v1:eip155-address:allocation')
)
export const scopeHash = keccak256(
  stringToHex('governance-voice-allocation-v1')
)

const source = ({
  idByte,
  snapshotByte,
  familyByte,
  stateIndex,
  freezeBlock,
  weight,
  entries,
}: {
  idByte: string
  snapshotByte: string
  familyByte: string
  stateIndex: bigint
  freezeBlock: bigint
  weight: bigint
  entries: Array<[string, bigint]>
}) =>
  sourceFromBlob({
    sourceId: word(idByte),
    snapshot: address(snapshotByte),
    familyId: word(familyByte),
    programId,
    stateIndex,
    freezeBlock,
    weight,
    maxAgeBlocks: 1_000n,
    blob: canonicalScoreBlob(
      entries.map(([accountByte, value]) => ({
        account: address(accountByte),
        value,
      }))
    ),
    required: true,
  })

export const fixturePolicy = (): CompositionPolicy => ({
  version: COMPOSITION_VERSION,
  chainId: 10n,
  captureBlock: 1_000_000n,
  scopeHash,
  identityDomain: 'eip155-address',
  outputKind: 'allocation',
  admittedProgramId: programId,
  weightScale: WEIGHT_SCALE,
  outputPool: 1_000_000n,
  bounds: V1_RESEARCH_BOUNDS,
  sources: [
    // A is the repository's existing trust-graph golden output: a real program-shaped source
    // with a 1e24 pool. B and C deliberately use unequal pools and partial/disjoint support.
    source({
      idByte: 'aa',
      snapshotByte: 'a1',
      familyByte: 'f1',
      stateIndex: 7n,
      freezeBlock: 999_900n,
      weight: 333_000_000_000_000_000n,
      entries: [
        ['01', 369_963_739_927_479_854_959_709n],
        ['02', 314_467_628_935_257_870_515_742n],
        ['03', 315_568_631_137_262_274_524_549n],
      ],
    }),
    source({
      idByte: 'bb',
      snapshotByte: 'b1',
      familyByte: 'f2',
      stateIndex: 12n,
      freezeBlock: 999_500n,
      weight: 333_000_000_000_000_000n,
      entries: [
        ['02', 50n],
        ['04', 30n],
        ['05', 20n],
      ],
    }),
    source({
      idByte: 'cc',
      snapshotByte: 'c1',
      familyByte: 'f3',
      stateIndex: 3n,
      freezeBlock: 999_999n,
      weight: 334_000_000_000_000_000n,
      entries: [
        ['01', 1n],
        ['05', 1n],
        ['06', 2n],
        ['07', 3n],
      ],
    }),
  ],
})

export const postTriggerPolicy = (): CompositionPolicy => {
  const frozen = fixturePolicy()
  const replacement = source({
    idByte: 'bb',
    snapshotByte: 'b1',
    familyByte: 'f2',
    stateIndex: 13n,
    freezeBlock: 1_000_010n,
    weight: 333_000_000_000_000_000n,
    entries: [['09', 100n]],
  })
  return {
    ...frozen,
    captureBlock: 1_000_010n,
    sources: frozen.sources.map((item) =>
      item.sourceId === replacement.sourceId ? replacement : item
    ),
  }
}

export const exportedFixture = () => {
  const policy = fixturePolicy()
  const result = compose(policy)
  const postTrigger = compose(postTriggerPolicy())
  return {
    sourceStates: policy.sources.map((item) => ({
      sourceId: item.sourceId,
      blobSha256: item.blobSha256,
      cid: item.cid,
      outputRoot: item.outputRoot,
      totalValue: item.totalValue,
    })),
    manifestSha256: result.manifestSha256,
    sourceQuotas: Object.fromEntries(
      result.sourceAllocations.map((item) => [item.sourceId, item.quota])
    ),
    sourceAllocations: Object.fromEntries(
      result.sourceAllocations.map((item) => [
        item.sourceId,
        Object.fromEntries(
          item.allocations.map((entry) => [entry.account, entry.value])
        ),
      ])
    ),
    output: Object.fromEntries(
      result.output.map((entry) => [entry.account, entry.value])
    ),
    outputBlobSha256: result.outputBlobSha256,
    outputCid: result.outputCid,
    outputRoot: result.outputRoot,
    totalValue: result.totalValue,
    postTriggerUpdate: {
      outputRoot: postTrigger.outputRoot,
      manifestSha256: postTrigger.manifestSha256,
    },
    expectedFailures: {
      stale: 'is stale at capture',
      wrongBlob: 'blob sha256 mismatch',
      wrongRoot: 'output root mismatch',
    },
  }
}
