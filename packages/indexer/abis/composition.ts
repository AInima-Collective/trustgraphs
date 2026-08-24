import { parseAbi } from 'viem'

export const COMPOSITION_PARAMS =
  '(uint32 version,bytes32 programId,bytes32 scopeHash,bytes32 identityDomain,bytes32 outputKind,bytes32 outputDomain,bytes32 admittedProgramId,uint64 weightScale,uint128 outputPool,bytes32 sourcePolicyRoot,uint8 sourceCount,bytes32 policyManifestSha256,uint8 maxSources,uint32 maxEntriesPerSource,uint32 maxAggregateEntries,uint32 maxUnionAccounts,uint32 maxAggregateBlobBytes,uint64 maxSourceAgeBlocks,address accumulator,uint64 chainId)'

export const COMPOSITION_CREATE_ARGS = `(string name,string metadataURI,${COMPOSITION_PARAMS} params,bytes policyManifest,address[] sourceAdapters,bytes32 metadataDigest,address admin,uint64 epochLength,bool withDistributor,address distributorToken,bytes32 salt)`

export const trustComposeFactoryAbi = parseAbi([
  `event TrustComposeInstanceCreated(bytes32 indexed instanceId,address indexed creator,address indexed admin,string name,string metadataURI,address accumulator,address snapshot,address distributor,address distributorToken,uint64 epochLength,bytes32 programVKey,bytes32 metadataDigest,${COMPOSITION_PARAMS} params)`,
  'event TrustComposeParamsControllerCreated(bytes32 indexed instanceId,address indexed controller)',
  'event DistributorAttached(bytes32 indexed instanceId,address distributor,address distributorToken)',
  `function createInstance(${COMPOSITION_CREATE_ARGS} args) payable returns (bytes32 instanceId,address snapshot,address accumulatorAddress,address distributor)`,
  'function attachDistributor(bytes32 instanceId,address owner,address distributorToken) returns (address distributor)',
])

/** The governed wrapper carries the same policy-bearing CreateArgs as the base factory. */
export const governedTrustComposeFactoryAbi = parseAbi([
  `function createGovernedInstance(${COMPOSITION_CREATE_ARGS} requested,(uint64 minPaidIntervalBlocks,uint96 maxPerRootUsd) policy,(bool enabled,uint32 topN,uint32 minThreshold,uint32 targetThresholdBps) signerSync) payable returns (bytes32 instanceId,address safeAddress,address merkleGovModule,address snapshot)`,
])

export const trustComposeParamsControllerAbi = parseAbi([
  `event InitialPolicyPublished(bytes32 indexed instanceId,uint64 indexed version,bytes32 indexed paramsHash,bytes32 adapterSetHash,bytes32 metadataDigest,${COMPOSITION_PARAMS} params)`,
  'event PolicyProposed(bytes32 indexed instanceId,uint64 indexed version,bytes32 indexed proposalId,bytes32 sourcePolicyRoot,uint8 sourceCount,bytes32 manifestSha256,bytes32 adapterSetHash,bytes32 metadataDigest,bytes32 paramsHash,uint48 readyAt)',
  `event PolicyActivated(bytes32 indexed instanceId,uint64 indexed version,bytes32 indexed paramsHash,bytes32 previousParamsHash,bytes32 proposalId,bytes32 adapterSetHash,bytes32 metadataDigest,${COMPOSITION_PARAMS} params)`,
  'event PolicyProposalCancelled(bytes32 indexed instanceId,uint64 indexed version,bytes32 indexed proposalId)',
  'function proposePolicy(bytes manifest,address[] adapters,bytes32 metadataDigest) returns (uint64 pendingVersion,bytes32 proposalId,uint48 readyAt)',
  `function getCurrentParams() view returns (${COMPOSITION_PARAMS})`,
])

export const compositionAccumulatorAbi = parseAbi([
  'event CaptureManifestStored(uint256 indexed checkpointId,bytes32 indexed sha256Digest,bytes manifest)',
  'event InputsCheckpointed(uint256 indexed id,bytes32 acc,uint64 leafCount,uint64 blockNumber)',
  'function checkpointPolicyVersion(uint256 checkpointId) view returns (uint64)',
  'function checkpointAdapterSetHash(uint256 checkpointId) view returns (bytes32)',
  'function getCaptureManifest(uint256 checkpointId) view returns (bytes)',
  'function getCaptureSourceCheckpointIds(uint256 checkpointId) view returns (uint256[])',
  'function getCheckpoint(uint256 checkpointId) view returns ((bytes32 acc,uint64 leafCount,uint64 blockNumber))',
])

export const compositionSourceAdapterAbi = parseAbi([
  'function sourceId() view returns (bytes32)',
  'function snapshot() view returns (address)',
  'function familyId() view returns (bytes32)',
  'function programId() view returns (bytes32)',
  'function outputKind() view returns (bytes32)',
  'function chainId() view returns (uint64)',
  'function deploymentProvenance() view returns (bytes32)',
])
