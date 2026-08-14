import { type Address, type Hex, encodeFunctionData, parseAbi } from 'viem'

import type { WeightedImportArtifacts } from './import'

const PARAMS =
  '(uint32 version,uint64 dampingFp,uint64 toleranceFp,uint32 maxIterations,uint64 minWeight,uint64 maxWeight,bytes32 priorRoot,uint32 priorCount,bytes32 manifestSha256,bytes32 schemaUid,uint32 weightFieldIndex,address accumulator,uint64 chainId)'

export const weightedTrustgraphsFactoryAbi = parseAbi([
  `event WeightedInstanceCreated(bytes32 indexed instanceId,address indexed creator,address indexed admin,string name,string metadataURI,address resolver,bytes32 schemaUid,address snapshot,address distributor,address distributorToken,uint64 epochLength,bytes32 metadataDigest,${PARAMS} params)`,
  'event WeightedParamsControllerCreated(bytes32 indexed instanceId,address indexed controller)',
  `function createInstance((string name,string metadataURI,${PARAMS} params,bytes manifest,bytes32 metadataDigest,address admin,uint64 epochLength,bool withDistributor,address distributorToken,bytes32 salt) args) payable returns (bytes32 instanceId,address snapshot,address resolver,address distributor,bytes32 schemaUid)`,
  'function EPOCH_FLOOR() view returns (uint64)',
])

export const weightedPriorParamsControllerAbi = parseAbi([
  'event PriorProposed(bytes32 indexed instanceId,uint64 indexed version,bytes32 indexed proposalId,bytes32 priorRoot,uint32 priorCount,bytes32 manifestSha256,bytes32 metadataDigest,bytes32 paramsHash,uint48 readyAt)',
  `event PriorActivated(bytes32 indexed instanceId,uint64 indexed version,bytes32 indexed paramsHash,bytes32 previousParamsHash,bytes32 proposalId,bytes32 metadataDigest,${PARAMS} params)`,
  'function proposePrior(bytes manifest,bytes32 metadataDigest) returns (uint64 pendingVersion,bytes32 proposalId,uint48 readyAt)',
  'function activatePrior(uint64 expectedVersion) returns (bytes32 paramsHash)',
  'function version() view returns (uint64)',
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

export const weightedRotationPayload = (
  artifacts: WeightedImportArtifacts
): Hex =>
  encodeFunctionData({
    abi: weightedPriorParamsControllerAbi,
    functionName: 'proposePrior',
    args: [artifacts.manifest, artifacts.metadataDigest],
  })
