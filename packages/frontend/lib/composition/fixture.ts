import type { Address, Hex } from 'viem'

import {
  type CompositionConfig,
  type CompositionEntry,
  type CompositionSource,
  DEFAULT_COMPOSITION_SCOPE,
  TRUST_GRAPH_SOURCE_PROGRAM_ID,
  V1_COMPOSITION_BOUNDS,
  WEIGHTED_TRUST_GRAPH_SOURCE_PROGRAM_ID,
  canonicalCompositionBlob,
  compositionOutputRoot,
} from './core'
import { cidV1Raw, digestToHex, sha256Utf8 } from '../pagerank/cid'

export const compositionFixtureProgramId =
  '0x8e3fcb8fae37df610887f6a917ca956aedb723004354ba17aee222d07f47af10' as Hex

const address = (byte: string) => `0x${byte.repeat(20)}` as Address
const word = (byte: string) => `0x${byte.repeat(32)}` as Hex

const fixtureSource = ({
  idByte,
  snapshotByte,
  familyByte,
  programId = compositionFixtureProgramId,
  stateIndex,
  freezeBlock,
  weight,
  entries,
}: {
  idByte: string
  snapshotByte: string
  familyByte: string
  programId?: Hex
  stateIndex: bigint
  freezeBlock: bigint
  weight: bigint
  entries: Array<[string, bigint]>
}): CompositionSource => {
  const exactEntries: CompositionEntry[] = entries.map(
    ([accountByte, value]) => ({
      account: address(accountByte),
      value,
    })
  )
  const blob = canonicalCompositionBlob(exactEntries)
  const digest = sha256Utf8(blob)
  return {
    instanceId: word(idByte),
    name: `Source ${idByte.toUpperCase()}`,
    chainId: 10n,
    sourceId: word(idByte),
    snapshot: address(snapshotByte),
    familyId: word(familyByte),
    programId,
    controller: address(idByte),
    registry: address('92'),
    verifier: address('93'),
    paramsHash: word('94'),
    adapter: null,
    deploymentProvenance: word('95'),
    stateIndex,
    checkpointId: stateIndex,
    acceptedAtBlock: freezeBlock,
    freezeBlock,
    outputRoot: compositionOutputRoot(exactEntries),
    blobSha256: digestToHex(digest),
    cid: cidV1Raw(digest),
    totalValue: exactEntries.reduce((sum, entry) => sum + entry.value, 0n),
    weight,
    maxAgeBlocks: 1_000n,
    entries: exactEntries,
    available: true,
    availabilityError: null,
  }
}

/** The cross-language A/B/C production fixture used by research, Rust, Solidity, and indexer. */
export const compositionGoldenFixture = (): CompositionConfig => ({
  chainId: 10n,
  captureBlock: 1_000_000n,
  scopeHash: DEFAULT_COMPOSITION_SCOPE,
  paramsVersion: 1,
  admittedProgramId: compositionFixtureProgramId,
  outputPool: 1_000_000n,
  bounds: V1_COMPOSITION_BOUNDS,
  sources: [
    fixtureSource({
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
    fixtureSource({
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
    fixtureSource({
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

/** The frozen mixed standard/weighted V2 fixture shared with Rust, SP1, Solidity, and indexer. */
export const compositionMixedGoldenFixture = (): CompositionConfig => ({
  chainId: 10n,
  captureBlock: 1_000_000n,
  scopeHash: DEFAULT_COMPOSITION_SCOPE,
  paramsVersion: 2,
  admittedProgramId: null,
  outputPool: 1_000n,
  bounds: V1_COMPOSITION_BOUNDS,
  sources: [
    fixtureSource({
      idByte: 'aa',
      snapshotByte: 'a1',
      familyByte: 'f1',
      programId: TRUST_GRAPH_SOURCE_PROGRAM_ID,
      stateIndex: 7n,
      freezeBlock: 999_900n,
      weight: 400_000_000_000_000_000n,
      entries: [
        ['01', 900_000_000_000_000_000_000_000n],
        ['02', 100_000_000_000_000_000_000_000n],
      ],
    }),
    fixtureSource({
      idByte: 'bb',
      snapshotByte: 'b1',
      familyByte: 'f2',
      programId: WEIGHTED_TRUST_GRAPH_SOURCE_PROGRAM_ID,
      stateIndex: 12n,
      freezeBlock: 999_500n,
      weight: 600_000_000_000_000_000n,
      entries: [
        ['02', 166_666_666_666_666_667n],
        ['03', 333_333_333_333_333_333n],
        ['04', 500_000_000_000_000_000n],
      ],
    }),
  ],
})
