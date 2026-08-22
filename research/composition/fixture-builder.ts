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
        ['01', 220_016_440_032_880_065_760_133n],
        ['02', 300_189_600_379_200_758_401_516n],
        ['03', 479_793_959_587_919_175_838_351n],
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
    note: 'Source A is tests/golden/trust-graph.json; B/C are representative unequal-pool sparse outputs.',
    policy,
    expected: result,
    postTriggerUpdate: {
      policy: postTriggerPolicy(),
      expectedOutputRoot: postTrigger.outputRoot,
      expectedManifestSha256: postTrigger.manifestSha256,
    },
    expectedFailures: {
      stale: 'is stale at capture',
      wrongBlob: 'blob sha256 mismatch',
      wrongRoot: 'output root mismatch',
    },
  }
}
