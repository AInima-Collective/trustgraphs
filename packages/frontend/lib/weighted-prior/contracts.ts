import { type Address, type Hex, encodeFunctionData, parseAbi } from 'viem'

import {
  DISABLED_SIGNER_SYNC,
  GOVERNED_WRAPPER_ERRORS,
  INITIAL_POLICY_TUPLE,
  SIGNER_SYNC_TUPLE,
} from '../governed-wrapper'
import type { InitialProvingPolicy } from '../proving-prepay'
import type { WeightedImportArtifacts } from './import'

const PARAMS =
  '(uint32 version,uint64 dampingFp,uint64 toleranceFp,uint32 maxIterations,uint64 minWeight,uint64 maxWeight,bytes32 priorRoot,uint32 priorCount,bytes32 manifestSha256,bytes32 schemaUid,uint32 weightFieldIndex,address accumulator,uint64 chainId)'

/** `WeightedTrustgraphsFactory.CreateArgs`, shared by the base and governed creation paths. */
const CREATE_ARGS =
  `(string name,string metadataURI,${PARAMS} params,bytes manifest,bytes32 metadataDigest,address admin,uint64 epochLength,bool withDistributor,address distributorToken,bytes32 salt)` as const

/** Base-factory and manifest-validation errors surfaced by direct creation simulation. */
const WEIGHTED_FACTORY_ERRORS = [
  'error ZeroAddress()',
  'error ZeroEpochFloor()',
  'error ZeroActivationDelay()',
  'error InvalidAdmin()',
  'error EmptyName()',
  'error NameTooLong(uint256 length)',
  'error NoVaultConfigured()',
  'error ChainIdTooLarge(uint256 chainId)',
  'error SchemaUidMismatch(bytes32 registered, bytes32 expected)',
  'error UnknownInstance(bytes32 instanceId)',
  'error NotInstanceAuthority(bytes32 instanceId, address owner)',
  'error DistributorAlreadyAttached(bytes32 instanceId, address distributor)',
  'error InvalidDistributorSafe(address owner)',
  'error DerivedFieldNotZero()',
  'error InvalidParamsVersion(uint32 version)',
  'error InvalidDamping(uint64 dampingFp)',
  'error InvalidTolerance(uint64 toleranceFp)',
  'error InvalidIterations(uint32 maxIterations)',
  'error InvalidWeightBounds(uint64 minWeight, uint64 maxWeight)',
  'error InvalidWeightFieldIndex(uint32 weightFieldIndex)',
  'error InvalidParamsChain(uint64 chainId)',
  'error InvalidManifestLength(uint256 actual, uint256 expected)',
  'error InvalidManifestMagic(bytes4 magic)',
  'error InvalidManifestVersion(uint16 version)',
  'error InvalidManifestChain(uint64 actual, uint64 expected)',
  'error InvalidPriorCount(uint32 count)',
  'error InvalidPriorAccount(uint32 index, address account)',
  'error PriorAccountsNotAscending(uint32 index, address previous, address account)',
  'error InvalidPriorWeight(uint32 index)',
  'error InvalidPriorWeightSum(uint256 sum)',
  'error PriorCommitmentMismatch()',
] as const

export const weightedTrustgraphsFactoryAbi = parseAbi([
  `event WeightedInstanceCreated(bytes32 indexed instanceId,address indexed creator,address indexed admin,string name,string metadataURI,address resolver,bytes32 schemaUid,address snapshot,address distributor,address distributorToken,uint64 epochLength,bytes32 metadataDigest,${PARAMS} params)`,
  'event WeightedParamsControllerCreated(bytes32 indexed instanceId,address indexed controller)',
  `function createInstance(${CREATE_ARGS} args) payable returns (bytes32 instanceId,address snapshot,address resolver,address distributor,bytes32 schemaUid)`,
  'function EPOCH_FLOOR() view returns (uint64)',
  'function PRIOR_ACTIVATION_DELAY() view returns (uint48)',
  ...WEIGHTED_FACTORY_ERRORS,
])

/**
 * `GovernedWeightedTrustgraphsFactory` (hand-audited against the Solidity, the lane-E pattern):
 * the same `CreateArgs` plus the wrapper's `InitialPolicy` and `SignerSyncConfig`. `requested.admin`
 * is deliberately ignored by the wrapper — the new one-owner Safe becomes the instance admin.
 * The profile reads and the `GovernedInstanceCreated` event live in `lib/governed-wrapper.ts`.
 */
export const governedWeightedTrustgraphsFactoryAbi = parseAbi([
  'event GovernedInstanceCreated(bytes32 indexed instanceId,address indexed creator,address indexed safe,address merkleGovModule,address snapshot)',
  'function authorityOf(bytes32 instanceId) view returns ((address safe,address governanceModule,address recoveryModule,address executionGuard,address initialRecoveryProposer,uint48 recoveryDelay,address signerSyncModule))',
  `function createGovernedInstance(${CREATE_ARGS} requested,${INITIAL_POLICY_TUPLE} policy,${SIGNER_SYNC_TUPLE} signerSync) payable returns (bytes32 instanceId,address safeAddress,address merkleGovModule,address snapshot)`,
  ...GOVERNED_WRAPPER_ERRORS,
])

export const weightedPriorParamsControllerAbi = parseAbi([
  'event PriorProposed(bytes32 indexed instanceId,uint64 indexed version,bytes32 indexed proposalId,bytes32 priorRoot,uint32 priorCount,bytes32 manifestSha256,bytes32 metadataDigest,bytes32 paramsHash,uint48 readyAt)',
  `event PriorActivated(bytes32 indexed instanceId,uint64 indexed version,bytes32 indexed paramsHash,bytes32 previousParamsHash,bytes32 proposalId,bytes32 metadataDigest,${PARAMS} params)`,
  'function proposePrior(bytes manifest,bytes32 metadataDigest) returns (uint64 pendingVersion,bytes32 proposalId,uint48 readyAt)',
  'function cancelPrior()',
  'function activatePrior(uint64 expectedVersion) returns (bytes32 paramsHash)',
  'function version() view returns (uint64)',
  'function latestVersion() view returns (uint64)',
  'function owner() view returns (address)',
  `function getCurrentParams() view returns (${PARAMS})`,
])

export interface WeightedCreationFields {
  name: string
  metadataURI: string
  dampingFp: bigint
  toleranceFp: bigint
  maxIterations: number
  minWeight: bigint
  maxWeight: bigint
  admin: Address
  epochLength: bigint
  withDistributor: boolean
  distributorToken: Address
  salt: Hex
}

export const weightedCreateArgs = (
  fields: WeightedCreationFields,
  artifacts: WeightedImportArtifacts
) => ({
  name: fields.name.trim(),
  metadataURI: fields.metadataURI.trim(),
  params: {
    version: 1,
    dampingFp: fields.dampingFp,
    toleranceFp: fields.toleranceFp,
    maxIterations: fields.maxIterations,
    minWeight: fields.minWeight,
    maxWeight: fields.maxWeight,
    // Factory-derived fields must be zero at creation. The preview commitments below are the
    // values the factory derives from these exact manifest bytes before it emits the instance.
    priorRoot: `0x${'0'.repeat(64)}` as Hex,
    priorCount: 0,
    manifestSha256: `0x${'0'.repeat(64)}` as Hex,
    schemaUid: `0x${'0'.repeat(64)}` as Hex,
    weightFieldIndex: 1,
    accumulator: `0x${'0'.repeat(40)}` as Address,
    chainId: 0n,
  },
  manifest: artifacts.manifest,
  metadataDigest: artifacts.metadataDigest,
  admin: fields.admin,
  epochLength: fields.epochLength,
  withDistributor: fields.withDistributor,
  distributorToken: fields.distributorToken,
  salt: fields.salt,
})

export const weightedCreatePayload = (
  fields: WeightedCreationFields,
  artifacts: WeightedImportArtifacts
): Hex =>
  encodeFunctionData({
    abi: weightedTrustgraphsFactoryAbi,
    functionName: 'createInstance',
    args: [weightedCreateArgs(fields, artifacts)],
  })

/**
 * Calldata for the governed creation path. Signer-sync is plumbed in the wrapper but not offered
 * for weighted networks (no weighted signer guest exists), so it is always the disabled config.
 */
export const weightedGovernedCreatePayload = (
  fields: WeightedCreationFields,
  artifacts: WeightedImportArtifacts,
  policy: InitialProvingPolicy
): Hex =>
  encodeFunctionData({
    abi: governedWeightedTrustgraphsFactoryAbi,
    functionName: 'createGovernedInstance',
    args: [weightedCreateArgs(fields, artifacts), policy, DISABLED_SIGNER_SYNC],
  })

export const weightedRotationPayload = (
  artifacts: WeightedImportArtifacts
): Hex =>
  encodeFunctionData({
    abi: weightedPriorParamsControllerAbi,
    functionName: 'proposePrior',
    args: [artifacts.manifest, artifacts.metadataDigest],
  })
