import type { Address, Hex } from 'viem'

import {
  type CompositionConfig,
  type CompositionEntry,
  type CompositionSource,
  DEFAULT_COMPOSITION_SCOPE,
  MAX_COMPOSITION_BOUNDS,
  TRUST_GRAPH_SOURCE_PROGRAM_ID,
  WEIGHTED_TRUST_GRAPH_SOURCE_PROGRAM_ID,
  canonicalCompositionBlob,
  compositionOutputRoot,
} from './core'
import { cidV1Raw, digestToHex, sha256Utf8 } from '../pagerank/cid'

const address = (byte: string) => `0x${byte.repeat(20)}` as Address
const word = (byte: string) => `0x${byte.repeat(32)}` as Hex

const fixtureSource = ({
  idByte,
  snapshotByte,
  familyByte,
  programId,
  stateIndex,
  freezeBlock,
  weight,
  entries,
}: {
  idByte: string
  snapshotByte: string
  familyByte: string
  programId: Hex
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

/** The frozen mixed standard/weighted fixture shared with Rust, SP1, Solidity, and indexer. */
export const compositionGoldenFixture = (): CompositionConfig => ({
  chainId: 10n,
  captureBlock: 1_000_000n,
  scopeHash: DEFAULT_COMPOSITION_SCOPE,
  outputPool: 1_000n,
  bounds: MAX_COMPOSITION_BOUNDS,
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
