import { parseAbi } from 'viem'

const PARAMS =
  '(uint32 version,uint64 dampingFp,uint64 toleranceFp,uint32 maxIterations,uint64 minWeight,uint64 maxWeight,bytes32 priorRoot,uint32 priorCount,bytes32 manifestSha256,bytes32 schemaUid,uint32 weightFieldIndex,address accumulator,uint64 chainId)'

export const weightedTrustgraphsFactoryAbi = parseAbi([
  `event WeightedInstanceCreated(bytes32 indexed instanceId,address indexed creator,address indexed admin,string name,string metadataURI,address resolver,bytes32 schemaUid,address snapshot,address distributor,address distributorToken,uint64 epochLength,bytes32 metadataDigest,${PARAMS} params)`,
  'event WeightedParamsControllerCreated(bytes32 indexed instanceId,address indexed controller)',
  `function createInstance((string name,string metadataURI,${PARAMS} params,bytes manifest,bytes32 metadataDigest,address admin,uint64 epochLength,bool withDistributor,address distributorToken,bytes32 salt) args) payable returns (bytes32 instanceId,address snapshot,address resolver,address distributor,bytes32 schemaUid)`,
])

export const weightedPriorParamsControllerAbi = parseAbi([
  `event InitialPriorPublished(bytes32 indexed instanceId,uint64 indexed version,bytes32 indexed paramsHash,bytes32 metadataDigest,${PARAMS} params)`,
  'event PriorProposed(bytes32 indexed instanceId,uint64 indexed version,bytes32 indexed proposalId,bytes32 priorRoot,uint32 priorCount,bytes32 manifestSha256,bytes32 metadataDigest,bytes32 paramsHash,uint48 readyAt)',
  `event PriorActivated(bytes32 indexed instanceId,uint64 indexed version,bytes32 indexed paramsHash,bytes32 previousParamsHash,bytes32 proposalId,bytes32 metadataDigest,${PARAMS} params)`,
  'event PriorProposalCancelled(bytes32 indexed instanceId,uint64 indexed version,bytes32 indexed proposalId)',
  'function proposePrior(bytes manifest,bytes32 metadataDigest) returns (uint64 pendingVersion,bytes32 proposalId,uint48 readyAt)',
  'function instanceId() view returns (bytes32)',
  'function snapshot() view returns (address)',
  'function version() view returns (uint64)',
  'function currentParamsHash() view returns (bytes32)',
  `function getCurrentParams() view returns (${PARAMS})`,
])
