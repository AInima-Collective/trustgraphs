import { keccak256, stringToHex, type Hex } from 'viem'

import { V1_RESEARCH_BOUNDS, WEIGHT_SCALE, canonicalScoreBlob } from './reference'
import {
  SOURCE_COMPATIBILITY_CLASS_V1,
  TRUST_GRAPH_OUTPUT_DOMAIN,
  TRUST_GRAPH_PROGRAM_ID,
  WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN,
  WEIGHTED_TRUST_GRAPH_PROGRAM_ID,
  sourceFromBlobV2,
  type CapturedSourceV2,
  type CompositionPolicyV2,
} from './reference-v2'

const address = (byte: string) => `0x${byte.repeat(20)}` as Hex
const word = (byte: string) => `0x${byte.repeat(32)}` as Hex

export const scopeHash = keccak256(stringToHex('governance-voice-allocation-v1'))

export const CONTRIBUTIONS_PROGRAM_ID = keccak256(stringToHex('contributions'))
export const CONTRIBUTIONS_OUTPUT_DOMAIN = keccak256(
  stringToHex('trustgraphs.output.contributions-recipient.v1')
)

const source = ({
  idByte,
  snapshotByte,
  familyByte,
  programId,
  sourceOutputDomain,
  stateIndex,
  freezeBlock,
  weight,
  entries,
}: {
  idByte: string
  snapshotByte: string
  familyByte: string
  programId: Hex
  sourceOutputDomain: Hex
  stateIndex: bigint
  freezeBlock: bigint
  weight: bigint
  entries: Array<[string, bigint]>
}) =>
  sourceFromBlobV2({
    sourceId: word(idByte),
    snapshot: address(snapshotByte),
    familyId: word(familyByte),
    programId,
    sourceOutputDomain,
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

/** Standard `trust-graph` source A: a 1e24-pool allocation. */
export const standardSourceA = (weight = 400_000_000_000_000_000n) =>
  source({
    idByte: 'aa',
    snapshotByte: 'a1',
    familyByte: 'f1',
    programId: TRUST_GRAPH_PROGRAM_ID,
    sourceOutputDomain: TRUST_GRAPH_OUTPUT_DOMAIN,
    stateIndex: 7n,
    freezeBlock: 999_900n,
    weight,
    entries: [
      ['01', 900_000_000_000_000_000_000_000n],
      ['02', 100_000_000_000_000_000_000_000n],
    ],
  })

/** Weighted `trust-graph-weighted` source B: a normalized 1e18-pool allocation. */
export const weightedSourceB = (weight = 600_000_000_000_000_000n) =>
  source({
    idByte: 'bb',
    snapshotByte: 'b1',
    familyByte: 'f2',
    programId: WEIGHTED_TRUST_GRAPH_PROGRAM_ID,
    sourceOutputDomain: WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN,
    stateIndex: 12n,
    freezeBlock: 999_500n,
    weight,
    entries: [
      ['02', 166_666_666_666_666_667n],
      ['03', 333_333_333_333_333_333n],
      ['04', 500_000_000_000_000_000n],
    ],
  })

/**
 * Unadmitted third source C. Its static policy fields are structurally valid;
 * every implementation must reject the program/output pair before this source's
 * blob is ever fetched or decoded, so C deliberately has no meaningful blob.
 */
export const incompatibleSourceC = (
  programId: Hex = CONTRIBUTIONS_PROGRAM_ID,
  sourceOutputDomain: Hex = CONTRIBUTIONS_OUTPUT_DOMAIN
): CapturedSourceV2 => ({
  sourceId: word('cc'),
  snapshot: address('c1'),
  familyId: word('f3'),
  programId,
  sourceOutputDomain,
  stateIndex: 13n,
  freezeBlock: 999_800n,
  weight: 100_000_000_000_000_000n,
  maxAgeBlocks: 1_000n,
  outputRoot: word('00'),
  blobSha256: word('00'),
  cid: '',
  totalValue: 0n,
  blob: '',
  required: true,
})

const basePolicy = (sources: CapturedSourceV2[]): CompositionPolicyV2 => ({
  version: 2,
  chainId: 10n,
  captureBlock: 1_000_000n,
  scopeHash,
  identityDomain: 'eip155-address',
  outputKind: 'allocation',
  sourceCompatibilityClass: SOURCE_COMPATIBILITY_CLASS_V1,
  weightScale: WEIGHT_SCALE,
  outputPool: 1_000n,
  bounds: V1_RESEARCH_BOUNDS,
  sources,
})

/** The valid mixed A+B fixture from the V2 decision record. */
export const mixedFixturePolicy = (): CompositionPolicyV2 =>
  basePolicy([standardSourceA(), weightedSourceB()])

/** The same sources supplied in [B, A] order; canonical output must not change. */
export const reversedMixedFixturePolicy = (): CompositionPolicyV2 =>
  basePolicy([weightedSourceB(), standardSourceA()])

/**
 * A/B reweighted to 35%/55% plus the unadmitted 10% source C, so the weight sum
 * and every structural field are valid and only pair admission can reject it.
 */
export const incompatibleThirdProgramPolicy = (
  programId?: Hex,
  sourceOutputDomain?: Hex
): CompositionPolicyV2 =>
  basePolicy([
    standardSourceA(350_000_000_000_000_000n),
    weightedSourceB(550_000_000_000_000_000n),
    incompatibleSourceC(programId, sourceOutputDomain),
  ])

/** A valid rotation of the mixed policy: same class and sources, new weights. */
export const rotatedMixedFixturePolicy = (): CompositionPolicyV2 =>
  basePolicy([
    standardSourceA(500_000_000_000_000_000n),
    weightedSourceB(500_000_000_000_000_000n),
  ])
