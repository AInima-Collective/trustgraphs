import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
} from 'viem'

import {
  COMPOSITION_IDENTITY_DOMAIN,
  COMPOSITION_OUTPUT_DOMAIN,
  COMPOSITION_OUTPUT_KIND,
  COMPOSITION_PROGRAM_ID,
  COMPOSITION_VERSION,
  type CompositionConfig,
  type CompositionPreview,
  type CompositionSource,
  MAX_SOURCE_AGE_BLOCKS,
  WEIGHT_SCALE,
} from './core'
import {
  DISABLED_SIGNER_SYNC,
  GOVERNED_WRAPPER_ERRORS,
  INITIAL_POLICY_TUPLE,
  SIGNER_SYNC_TUPLE,
} from '../governed-wrapper'
import { ZERO_ADDRESS, ZERO_HASH } from '../pagerank/words'
import type { InitialProvingPolicy } from '../proving-prepay'

const PARAMS =
  '(uint32 version,bytes32 programId,bytes32 scopeHash,bytes32 identityDomain,bytes32 outputKind,bytes32 outputDomain,bytes32 admittedProgramId,uint64 weightScale,uint128 outputPool,bytes32 sourcePolicyRoot,uint8 sourceCount,bytes32 policyManifestSha256,uint8 maxSources,uint32 maxEntriesPerSource,uint32 maxAggregateEntries,uint32 maxUnionAccounts,uint32 maxAggregateBlobBytes,uint64 maxSourceAgeBlocks,address accumulator,uint64 chainId)'

/** `TrustComposeFactory.CreateArgs`, shared by the base and governed creation paths. */
const CREATE_ARGS =
  `(string name,string metadataURI,${PARAMS} params,bytes policyManifest,address[] sourceAdapters,bytes32 metadataDigest,address admin,uint64 epochLength,bool withDistributor,address distributorToken,bytes32 salt)` as const

/** Base-factory and policy-validation errors surfaced by direct creation simulation. */
const TRUST_COMPOSE_FACTORY_ERRORS = [
  'error ZeroAddress()',
  'error ZeroEpochFloor()',
  'error ZeroActivationDelay()',
  'error InvalidAdmin()',
  'error EmptyName()',
  'error NameTooLong(uint256 length)',
  'error NoVaultConfigured()',
  'error ChainIdTooLarge(uint256 chainId)',
  'error InvalidCompositionVerifier()',
  'error ProgramVKeyMismatch(bytes32 expected, bytes32 actual)',
  'error SourceAdapterRegistryMismatch(address expected, address actual)',
  'error UnknownInstance(bytes32 instanceId)',
  'error NotInstanceAuthority(bytes32 instanceId, address owner)',
  'error DistributorAlreadyAttached(bytes32 instanceId, address distributor)',
  'error InvalidDistributorSafe(address owner)',
  'error InvalidParamsVersion(uint32 version)',
  'error InvalidProgramId(bytes32 programId)',
  'error InvalidScope()',
  'error InvalidIdentityDomain(bytes32 identityDomain)',
  'error InvalidOutputKind(bytes32 outputKind)',
  'error InvalidOutputDomain(bytes32 outputDomain)',
  'error InvalidAdmittedProgram(bytes32 programId)',
  'error InvalidWeightScale(uint64 weightScale)',
  'error InvalidOutputPool()',
  'error InvalidSourceCount(uint8 count)',
  'error InvalidPolicyCommitment()',
  'error InvalidBounds()',
  'error InvalidMaxSourceAge(uint64 maxAgeBlocks)',
  'error InvalidAccumulator()',
  'error InvalidChain(uint64 chainId)',
  'error InvalidManifestLength(uint256 actual, uint256 expected)',
  'error InvalidManifestMagic(bytes4 magic)',
  'error InvalidManifestVersion(uint16 version)',
  'error InvalidManifestChain(uint64 actual, uint64 expected)',
  'error InvalidSourceId(uint8 index, bytes32 sourceId)',
  'error SourceIdsNotAscending(uint8 index, bytes32 previous, bytes32 sourceId)',
  'error InvalidSnapshot(uint8 index, address snapshot)',
  'error DuplicateSnapshot(uint8 index, address snapshot)',
  'error InvalidFamilyId(uint8 index)',
  'error UnadmittedSourceProgram(uint8 index, bytes32 programId)',
  'error InvalidSourceWeight(uint8 index)',
  'error InvalidWeightSum(uint256 sum)',
  'error InvalidSourceAge(uint8 index, uint64 maxAgeBlocks)',
  'error OptionalSourceUnsupported(uint8 index)',
  'error PolicyCommitmentMismatch()',
  'error DerivedFieldNotZero()',
  'error NotBinder()',
  'error AlreadyBound()',
  'error SnapshotReadsAnotherAccumulator(address reads)',
  'error NotSnapshot()',
  'error NotController()',
  'error InvalidPolicyVersion(uint64 current, uint64 proposed)',
  'error AdapterCountMismatch(uint256 expected, uint256 actual)',
  'error UnauthenticatedAdapter(uint8 index, address adapter)',
  'error DuplicateAdapter(uint8 index, address adapter)',
  'error AdapterPolicyMismatch(uint8 index)',
  'error WrongOutputKind(uint8 index, bytes32 outputKind)',
  'error WrongAdapterChain(uint8 index, uint64 chainId)',
] as const

export const trustComposeFactoryAbi = parseAbi([
  `event TrustComposeInstanceCreated(bytes32 indexed instanceId,address indexed creator,address indexed admin,string name,string metadataURI,address accumulator,address snapshot,address distributor,address distributorToken,uint64 epochLength,bytes32 programVKey,bytes32 metadataDigest,${PARAMS} params)`,
  'event TrustComposeParamsControllerCreated(bytes32 indexed instanceId,address indexed controller)',
  `function createInstance(${CREATE_ARGS} args) payable returns (bytes32 instanceId,address snapshot,address accumulatorAddress,address distributor)`,
  'function computeInstanceId(address creator,string name,bytes32 salt) pure returns (bytes32)',
  'function validateCreation((uint32 version,bytes32 programId,bytes32 scopeHash,bytes32 identityDomain,bytes32 outputKind,bytes32 outputDomain,bytes32 admittedProgramId,uint64 weightScale,uint128 outputPool,bytes32 sourcePolicyRoot,uint8 sourceCount,bytes32 policyManifestSha256,uint8 maxSources,uint32 maxEntriesPerSource,uint32 maxAggregateEntries,uint32 maxUnionAccounts,uint32 maxAggregateBlobBytes,uint64 maxSourceAgeBlocks,address accumulator,uint64 chainId) params,bytes manifest) view',
  'function EPOCH_FLOOR() view returns (uint64)',
  'function POLICY_ACTIVATION_DELAY() view returns (uint48)',
  'function SOURCE_ADAPTER_FACTORY() view returns (address)',
  'function VAULT() view returns (address)',
  ...TRUST_COMPOSE_FACTORY_ERRORS,
])

/**
 * `GovernedTrustComposeFactory` (hand-audited against the Solidity, the lane-E pattern): the same
 * `CreateArgs` plus the wrapper's `InitialPolicy` and `SignerSyncConfig`. `requested.admin` is
 * deliberately ignored by the wrapper — the new one-owner Safe becomes the instance admin. The
 * profile reads and the `GovernedInstanceCreated` event live in `lib/governed-wrapper.ts`.
 */
export const governedTrustComposeFactoryAbi = parseAbi([
  'event GovernedInstanceCreated(bytes32 indexed instanceId,address indexed creator,address indexed safe,address merkleGovModule,address snapshot)',
  `function createGovernedInstance(${CREATE_ARGS} requested,${INITIAL_POLICY_TUPLE} policy,${SIGNER_SYNC_TUPLE} signerSync) payable returns (bytes32 instanceId,address safeAddress,address merkleGovModule,address snapshot)`,
  ...GOVERNED_WRAPPER_ERRORS,
])

export const trustComposeParamsControllerAbi = parseAbi([
  `event InitialPolicyPublished(bytes32 indexed instanceId,uint64 indexed version,bytes32 indexed paramsHash,bytes32 adapterSetHash,bytes32 metadataDigest,${PARAMS} params)`,
  'event PolicyProposed(bytes32 indexed instanceId,uint64 indexed version,bytes32 indexed proposalId,bytes32 sourcePolicyRoot,uint8 sourceCount,bytes32 manifestSha256,bytes32 adapterSetHash,bytes32 metadataDigest,bytes32 paramsHash,uint48 readyAt)',
  `event PolicyActivated(bytes32 indexed instanceId,uint64 indexed version,bytes32 indexed paramsHash,bytes32 previousParamsHash,bytes32 proposalId,bytes32 adapterSetHash,bytes32 metadataDigest,${PARAMS} params)`,
  'event PolicyProposalCancelled(bytes32 indexed instanceId,uint64 indexed version,bytes32 indexed proposalId)',
  'function proposePolicy(bytes manifest,address[] adapters,bytes32 metadataDigest) returns (uint64 pendingVersion,bytes32 proposalId,uint48 readyAt)',
  'function cancelPolicy()',
  'function activatePolicy(uint64 expectedVersion,bytes manifest,address[] adapters) returns (bytes32 newHash)',
  'function owner() view returns (address)',
  'function activationDelay() view returns (uint48)',
  'function version() view returns (uint64)',
  'function latestVersion() view returns (uint64)',
  'function currentParamsHash() view returns (bytes32)',
  `function getCurrentParams() view returns (${PARAMS})`,
  'function getPendingPolicy() view returns ((uint64 version,uint48 readyAt,bytes32 proposalId,bytes32 sourcePolicyRoot,uint8 sourceCount,bytes32 manifestSha256,bytes32 adapterSetHash,bytes32 metadataDigest,bytes32 paramsHash))',
  'function versionCommitment(uint64 version) view returns ((bytes32 paramsHash,bytes32 sourcePolicyRoot,uint8 sourceCount,bytes32 manifestSha256,bytes32 adapterSetHash,bytes32 metadataDigest,uint48 proposedAt,uint48 activatedAt,uint48 cancelledAt,uint8 status))',
])

export const compositionSourceAdapterFactoryAbi = parseAbi([
  'event SourceAdapterCreated(address indexed adapter,address indexed registry,bytes32 indexed instanceId,bytes32 sourceId,address snapshot,bytes32 programId,bytes32 deploymentProvenance)',
  'function create(address registry,bytes32 instanceId,bytes32 sourceId,bytes32 familyId,bytes32 outputKind,bytes32 deploymentProvenance) returns (address adapter)',
  'function registry() view returns (address)',
  'function isAdapter(address adapter) view returns (bool)',
  'error ForeignRegistry(address expected,address actual)',
])

export const compositionSourceAdapterAbi = parseAbi([
  'function registry() view returns (address)',
  'function instanceId() view returns (bytes32)',
  'function chainId() view returns (uint64)',
  'function sourceId() view returns (bytes32)',
  'function snapshot() view returns (address)',
  'function familyId() view returns (bytes32)',
  'function programId() view returns (bytes32)',
  'function outputKind() view returns (bytes32)',
  'function deploymentProvenance() view returns (bytes32)',
  'function paramsAuthority() view returns (address)',
  'function verifier() view returns (address)',
  'function programVKey() view returns (bytes32)',
])

export const compositionSourceSnapshotAbi = parseAbi([
  'function provenanceEnabled() view returns (bool)',
  'function getStateCount() view returns (uint256)',
  'function getStateAtIndex(uint256 index) view returns ((uint256 blockNumber,uint256 timestamp,bytes32 root,bytes32 ipfsHash,string ipfsHashCid,uint256 totalValue))',
  'function getStateProvenance(uint256 stateIndex) view returns ((uint256 stateIndex,uint256 checkpointId,uint64 acceptedAtBlock,bytes32 paramsHash,address verifier,bytes32 verifierCodehash,bytes32 programVKey))',
])

export const compositionVaultAbi = parseAbi([
  'function feePerRootUsd(bytes32 program,uint8 band) view returns (uint256)',
  'function quote(bytes32 instanceId,uint256 checkpointId) view returns (uint256 feeUsd,uint256 gasUsd,uint256 payableUsd,bool eligible,uint8 reason)',
  'function accountOf(bytes32 instanceId) view returns (address snapshot,bytes32 program,uint128 ethBalance,uint128 usdcBalance)',
  'function policyOf(bytes32 instanceId) view returns (uint64 minPaidIntervalBlocks,uint96 maxPerRootUsd,uint64 lastPaidBlock)',
  'function setPolicy(bytes32 instanceId,uint64 minPaidIntervalBlocks,uint96 maxPerRootUsd)',
])

export type CompositionCreationFields = {
  name: string
  metadataURI: string
  admin: Address
  epochLength: bigint
  withDistributor: boolean
  distributorToken: Address
  salt: Hex
}

export const compositionSourceAdapters = (
  sources: CompositionSource[]
): Address[] =>
  [...sources]
    .sort((left, right) =>
      left.sourceId.toLowerCase().localeCompare(right.sourceId.toLowerCase())
    )
    .map((source) => {
      if (!source.adapter) {
        throw new Error(`${source.name} has no authenticated source adapter.`)
      }
      return source.adapter
    })

export const compositionMetadataDigest = (
  preview: CompositionPreview,
  adapters: Address[]
): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'address[]' },
      ],
      [
        preview.sourcePolicyRoot,
        preview.policyManifestSha256,
        preview.captureManifestSha256,
        preview.outputRoot,
        adapters,
      ]
    )
  )

export const compositionAdapterSetHash = (adapters: Address[]): Hex =>
  keccak256(encodeAbiParameters([{ type: 'address[]' }], [adapters]))

export const compositionCreateArgs = (
  fields: CompositionCreationFields,
  config: CompositionConfig,
  preview: CompositionPreview
) => {
  const adapters = compositionSourceAdapters(config.sources)
  return {
    name: fields.name.trim(),
    metadataURI: fields.metadataURI.trim(),
    params: {
      version: COMPOSITION_VERSION,
      programId: COMPOSITION_PROGRAM_ID,
      scopeHash: config.scopeHash,
      identityDomain: COMPOSITION_IDENTITY_DOMAIN,
      outputKind: COMPOSITION_OUTPUT_KIND,
      outputDomain: COMPOSITION_OUTPUT_DOMAIN,
      admittedProgramId: config.admittedProgramId,
      weightScale: WEIGHT_SCALE,
      outputPool: config.outputPool,
      // The factory derives these five fields after it deploys the accumulator. Supplying their
      // preview values would make otherwise correct creation calldata revert.
      sourcePolicyRoot: ZERO_HASH,
      sourceCount: 0,
      policyManifestSha256: ZERO_HASH,
      maxSources: config.bounds.maxSources,
      maxEntriesPerSource: config.bounds.maxEntriesPerSource,
      maxAggregateEntries: config.bounds.maxAggregateEntries,
      maxUnionAccounts: config.bounds.maxUnionAccounts,
      maxAggregateBlobBytes: config.bounds.maxAggregateBlobBytes,
      maxSourceAgeBlocks: MAX_SOURCE_AGE_BLOCKS,
      accumulator: ZERO_ADDRESS,
      chainId: 0n,
    },
    policyManifest: preview.policyManifest,
    sourceAdapters: adapters,
    metadataDigest: compositionMetadataDigest(preview, adapters),
    admin: fields.admin,
    epochLength: fields.epochLength,
    withDistributor: fields.withDistributor,
    distributorToken: fields.distributorToken,
    salt: fields.salt,
  }
}

export const compositionCreatePayload = (
  fields: CompositionCreationFields,
  config: CompositionConfig,
  preview: CompositionPreview
): Hex =>
  encodeFunctionData({
    abi: trustComposeFactoryAbi,
    functionName: 'createInstance',
    args: [compositionCreateArgs(fields, config, preview)],
  })

/**
 * Calldata for the governed creation path. Signer-sync is plumbed in the wrapper but not offered
 * for compositions (no compose signer guest exists), so it is always the disabled config.
 */
export const compositionGovernedCreatePayload = (
  fields: CompositionCreationFields,
  config: CompositionConfig,
  preview: CompositionPreview,
  policy: InitialProvingPolicy
): Hex =>
  encodeFunctionData({
    abi: governedTrustComposeFactoryAbi,
    functionName: 'createGovernedInstance',
    args: [
      compositionCreateArgs(fields, config, preview),
      policy,
      DISABLED_SIGNER_SYNC,
    ],
  })

export const compositionAdapterPayload = (source: CompositionSource): Hex =>
  encodeFunctionData({
    abi: compositionSourceAdapterFactoryAbi,
    functionName: 'create',
    args: [
      source.registry,
      source.instanceId,
      source.sourceId,
      source.familyId,
      COMPOSITION_OUTPUT_KIND,
      source.deploymentProvenance,
    ],
  })

export const compositionProposalPayload = (
  config: CompositionConfig,
  preview: CompositionPreview
): Hex => {
  const adapters = compositionSourceAdapters(config.sources)
  return encodeFunctionData({
    abi: trustComposeParamsControllerAbi,
    functionName: 'proposePolicy',
    args: [
      preview.policyManifest,
      adapters,
      compositionMetadataDigest(preview, adapters),
    ],
  })
}

export const compositionCancellationPayload = (): Hex =>
  encodeFunctionData({
    abi: trustComposeParamsControllerAbi,
    functionName: 'cancelPolicy',
  })

export const compositionActivationPayload = (
  version: bigint,
  manifest: Hex,
  adapters: Address[]
): Hex =>
  encodeFunctionData({
    abi: trustComposeParamsControllerAbi,
    functionName: 'activatePolicy',
    args: [version, manifest, adapters],
  })
