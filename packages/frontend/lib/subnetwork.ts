import { type Hex, parseAbi } from 'viem'

import { APIS } from './config'

const PARAMS =
  '(uint256 dampingFp,uint256 toleranceFp,uint32 maxIterations,uint256 minWeightFp,uint256 maxWeightFp,uint256 trustShareFp,uint256 trustDecayFp,address[] trustedSeeds,uint256 totalPool,uint256 precisionScale,bytes32 schemaUid,uint32 weightFieldIndex,bytes32[] envelope0DomainSeparators,uint64 lane2MaxHeadAge,address accumulator,uint64 chainId)'
const CREATE_ARGS = `(string name,string metadataURI,${PARAMS} params,address admin,uint64 epochLength,bool withDistributor,address distributorToken,bytes32 salt)`
const INITIAL_POLICY = '(uint64 minPaidIntervalBlocks,uint96 maxPerRootUsd)'
const SIGNER_SYNC =
  '(bool enabled,uint32 topN,uint32 minThreshold,uint32 targetThresholdBps)'

export const governedSubnetworkFactoryAbi = parseAbi([
  `function createGovernedSubnetwork(${CREATE_ARGS} requested,${INITIAL_POLICY} policy,${SIGNER_SYNC} signerSync,bytes32 parentInstanceId,uint8 tier) payable returns (bytes32 instanceId,address safeAddress,address merkleGovModule,address snapshot)`,
  'event GovernedSubnetworkCreated(bytes32 indexed childInstanceId,bytes32 indexed parentInstanceId,address indexed parentAuthorityModule,uint8 tier)',
])

export const subnetworkRegistryWriteAbi = parseAbi([
  'function claimParent(bytes32 childInstanceId,bytes32 parentInstanceId)',
  'function acceptChild(bytes32 childInstanceId)',
  'function release(bytes32 childInstanceId)',
])

export const subnetworkRegistryReadAbi = parseAbi([
  'function INSTANCE_REGISTRY() view returns (address)',
  'function authorityOf(bytes32 instanceId) view returns (address)',
])

export const parentAuthorityModuleDeployerAbi = parseAbi([
  'function deploy(address childSafe,address instanceRegistry,bytes32 childInstanceId,bytes32 parentInstanceId,uint48 executionDelay) returns (address module)',
  'event ParentAuthorityModuleConfigured(bytes32 indexed childInstanceId,bytes32 indexed parentInstanceId,address indexed parentAuthorityModule,address childSafe,address instanceRegistry,uint48 executionDelay)',
])

export const safeModuleWriteAbi = parseAbi([
  'function enableModule(address module)',
])

export const recoveryProposerWriteAbi = parseAbi([
  'function setProposer(address newProposer)',
])

export const parentAuthorityModuleWriteAbi = parseAbi(['function renounce()'])

export type SubnetworkCatalogEntry = {
  id: Hex
  name: string
  admin: Hex
  snapshot: Hex
  program:
    | 'trust-graph'
    | 'trust-graph-weighted'
    | 'trust-compose'
    | 'contributions'
}

export type SubnetworkRelationship = {
  child: SubnetworkCatalogEntry | null
  parent: SubnetworkCatalogEntry | null
  registry: Hex
  status: 'pending' | 'active' | 'cancelled' | 'released'
  actor: Hex
  power: {
    verified: boolean
    instruments: Array<
      'parent-module' | 'constitutional-role' | 'recovery-proposer'
    >
    tier: 'admin' | 'guardian' | 'department' | 'label'
    parentModule: {
      address: Hex
      safe: Hex
      executionDelay: string
    } | null
    recoveryModule: {
      address: Hex
      proposer: Hex
      delay: string
    } | null
  }
  updatedBlock: string
  updatedTimestamp: string
  updatedTxHash: Hex
}

export const fetchSubnetworkParent = async (
  childInstanceId: Hex
): Promise<SubnetworkRelationship | null> => {
  const response = await fetch(`${APIS.ponder}/subnetworks/${childInstanceId}`)
  if (response.status === 404) return null
  if (!response.ok)
    throw new Error(`Subnetwork lookup failed (${response.status})`)
  return response.json()
}

export const fetchSubnetworkChildren = async (
  parentInstanceId: Hex,
  status: 'active' | 'pending' = 'active'
): Promise<SubnetworkRelationship[]> => {
  const response = await fetch(
    `${APIS.ponder}/subnetworks/parents/${parentInstanceId}/children?status=${status}`
  )
  if (!response.ok)
    throw new Error(`Subnetwork lookup failed (${response.status})`)
  const body = (await response.json()) as {
    children?: SubnetworkRelationship[]
  }
  return body.children ?? []
}
