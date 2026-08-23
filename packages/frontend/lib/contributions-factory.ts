//! The contributions ROUND factory's client seam (network-creation GOAL M7).
//!
//! Hand-audited ABI, the weighted-workspace pattern (`lib/weighted-prior/contracts.ts`): the
//! round-creation flow is additive and must not depend on the generated binary contract map, so
//! only the surface the app calls lives here.

import { type Address, type Hex, parseAbi } from 'viem'

import type { InstanceParamsJson } from './catalog'

/** The 21-field contributions params tuple, matching `ContributionsParamsCodec.Params`. */
const PARAMS =
  '(uint256 dampingFp,uint256 toleranceFp,uint32 maxIterations,uint256 minWeightFp,uint256 maxWeightFp,uint256 trustShareFp,uint256 trustDecayFp,address[] trustedSeeds,uint256 precisionScale,uint32 weightFieldIndex,uint64 roundStart,uint64 roundEnd,uint256 unacceptedMultFp,uint256 collaboratorMultFp,uint256 minRaterRepFp,uint32 evaluatorCarveoutBps,uint256 totalPool,bytes32 claimSchemaUid,bytes32 responseSchemaUid,bytes32 valuationSchemaUid)'

export const contributionsFactoryAbi = parseAbi([
  `event ContributionsInstanceCreated(bytes32 indexed instanceId,bytes32 indexed parentInstanceId,address indexed creator,address admin,string name,string metadataURI,address trustAccumulator,address mirror,address resolver,address snapshot,address distributor,address distributorToken,uint64 epochLength,bytes32 claimSchemaUid,bytes32 responseSchemaUid,bytes32 valuationSchemaUid,${PARAMS} params)`,
  `function createInstance((bytes32 parentInstanceId,string name,string metadataURI,${PARAMS} params,address admin,uint64 epochLength,address distributorToken,bytes32 salt) args) returns (bytes32 instanceId,address snapshot,address resolver,address mirror,address distributor)`,
  `function validateParams(${PARAMS} params) view`,
  'function validateParent(bytes32 parentInstanceId, address creator) view returns (address)',
  'function computeInstanceId(address creator, string name, bytes32 salt) pure returns (bytes32)',
  'function EPOCH_FLOOR() view returns (uint64)',
])

/**
 * The parent snapshot role that gates round creation:
 * `MerkleSnapshot.CONSTITUTIONAL_ROLE == keccak256("CONSTITUTIONAL_ROLE")`.
 */
export const PARENT_AUTHORITY_ROLE =
  '0xb56660dd973371aa322644c54be4634423657e5045bdfd9a7a3b0b7c2a3d507e' as Hex

/** The fixed-point scale every instance uses (the guest's own constant). */
export const PRECISION_SCALE = 10n ** 18n

/** What the round wizard collects; everything else is derived or a documented default. */
export interface RoundCreationFields {
  name: string
  /** Unix seconds, inclusive window the guest counts claims in. */
  roundStart: bigint
  roundEnd: bigint
  /** The distribution scale the pool splits over (proportional shares, not a token amount). */
  totalPool: bigint
  /** Rater carve-out in basis points (100 = 1%). */
  evaluatorCarveoutBps: number
  /** Optional intended payout token; presentation only (the fund is multi-token). */
  distributorToken: Address
  salt: Hex
}

/**
 * Build `CreateArgs` for `ContributionsFactory.createInstance`: stage-1 (slots 1-11) mirrors the
 * PARENT network's live scoring params exactly (that is the design: the round re-runs the trust
 * algorithm over the parent's vouch graph), the round knobs come from the form, the consent
 * defaults are the design-of-record ones (0.5 x scale), and the three schema UIDs are left at
 * zero for the factory to derive.
 */
export const contributionsCreateArgs = (
  parentInstanceId: Hex,
  parentParams: InstanceParamsJson,
  parentEpochLength: bigint,
  fields: RoundCreationFields
) => ({
  parentInstanceId,
  name: fields.name.trim(),
  metadataURI: '',
  params: {
    dampingFp: BigInt(parentParams.dampingFp),
    toleranceFp: BigInt(parentParams.toleranceFp),
    maxIterations: parentParams.maxIterations,
    minWeightFp: BigInt(parentParams.minWeightFp),
    maxWeightFp: BigInt(parentParams.maxWeightFp),
    trustShareFp: BigInt(parentParams.trustShareFp),
    trustDecayFp: BigInt(parentParams.trustDecayFp),
    trustedSeeds: parentParams.trustedSeeds,
    precisionScale: BigInt(parentParams.precisionScale),
    weightFieldIndex: parentParams.weightFieldIndex,
    roundStart: fields.roundStart,
    roundEnd: fields.roundEnd,
    // Design-of-record defaults (research/CONTRIBUTION_FUNDING.md): a named contributor who has
    // not responded counts at half weight, and a same-round collaborator's rating counts at half
    // weight. Both are rotatable later through the round's typed params controller.
    unacceptedMultFp: PRECISION_SCALE / 2n,
    collaboratorMultFp: PRECISION_SCALE / 2n,
    minRaterRepFp: 0n,
    evaluatorCarveoutBps: fields.evaluatorCarveoutBps,
    totalPool: fields.totalPool,
    claimSchemaUid: `0x${'0'.repeat(64)}` as Hex,
    responseSchemaUid: `0x${'0'.repeat(64)}` as Hex,
    valuationSchemaUid: `0x${'0'.repeat(64)}` as Hex,
  },
  admin: `0x${'0'.repeat(40)}` as Address, // zero = the creator (the parent authority)
  epochLength: parentEpochLength,
  distributorToken: fields.distributorToken,
  salt: fields.salt,
})
