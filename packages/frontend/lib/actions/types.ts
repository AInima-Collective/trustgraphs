import type { Address, Hex } from 'viem'

import type { Params } from '../pagerank/types'
import type { ExactParamsJson } from '../scoring-params'

export type SafeOperation = 0 | 1

/** The canonical transaction tuple accepted by MerkleGovModule and the Safe. */
export type SafeAction = {
  target: Address
  value: string
  data: Hex
  operation: SafeOperation
  description?: string
}

export type GovernanceActionCategory =
  | 'treasury'
  | 'scoring'
  | 'network'
  | 'membership'
  | 'governance'
  | 'safety'
  | 'vault'
  | 'programs'
  | 'custom'

/**
 * Only addresses authenticated for the network being viewed belong here. Matchers must compare
 * action targets with this context before assigning a friendly presentation to calldata.
 */
export type GovernanceActionContext = {
  instanceId?: Hex
  snapshot?: Address
  paramsController?: Address
  signerSyncModule?: Address
  recoveryModule?: Address
  executionGuard?: Address
  weightedParamsController?: Address
  compositionParamsController?: Address
  treasurySafe?: Address
  fundDistributor?: Address
  governanceModule?: Address
  provingVault?: Address
  contributionsFactory?: Address
}

export type GovernanceActionMatch<Values = unknown> = {
  values: Values
  consumed: number
}

export interface MatchableGovernanceAction {
  key: string
  category: GovernanceActionCategory
  label: string
  summary: string
  danger?: boolean
  match(
    actions: readonly SafeAction[],
    index: number,
    context: GovernanceActionContext
  ): GovernanceActionMatch | null
}

export interface GovernanceActionDefinition<Values>
  extends Omit<MatchableGovernanceAction, 'match'> {
  encode(values: Values, context: GovernanceActionContext): SafeAction[]
  match(
    actions: readonly SafeAction[],
    index: number,
    context: GovernanceActionContext
  ): GovernanceActionMatch<Values> | null
}

export type ScoringParamsActionValues = {
  proposed: Params
  evidenceURI: string
  syncSigner: boolean
}

export type SignerParamsActionValues = {
  paramsHash: Hex
}

export type EthTransferActionValues = {
  recipient: Address
  value: string
  description?: string
}

export type CustomActionValues = SafeAction

export type NetworkProfileActionValues = {
  snapshot?: Address
  metadataURI: string
}

export type SignerPauseActionValues = {
  paused: boolean
}

export type WeightedPriorRotationActionValues = {
  controller: Address
  manifest: Hex
  metadataDigest: Hex
}

export type CompositionPolicyActionValues = {
  manifest: Hex
  adapters: Address[]
  metadataDigest: Hex
}

export type VaultPolicyActionValues = {
  minPaidIntervalBlocks: string
  maxPerRootUsd: string
}

export type VaultWithdrawalRequestActionValues = {
  ethAmount: string
  usdcAmount: string
}

export type VaultWithdrawalExecuteActionValues = {
  recipient: Address
}

export type SafetyAddressActionValues = {
  address: Address
}

export type RecoveryCancelActionValues = {
  actionId: Hex
}

export type SafeDisableModuleActionValues = {
  previousModule: Address
  module: Address
}

export type SafeSwapOwnerActionValues = {
  previousOwner: Address
  oldOwner: Address
  newOwner: Address
}

export type ContributionRoundActionValues = {
  parentParams?: ExactParamsJson
  parentEpochLength?: string
  name: string
  roundStart: string
  roundEnd: string
  totalPool: string
  evaluatorCarveoutBps: string
  distributorToken: Address
  salt: Hex
}

export type Erc20TransferActionValues = {
  token: Address
  recipient: Address
  amount: string
}

export type RewardDistributionActionValues = {
  token: Address
  amount: string
  expectedRoot: Hex
  expectedTotalMerkleValue: string
  claimDeadline: string
  maxFeeAmount: string
  expectedFeeRecipient: Address
}

export type RewardsPauseActionValues = {
  paused: boolean
}

export type RewardsFeeRecipientActionValues = {
  recipient: Address
}

export type RewardsFeePercentageActionValues = {
  feePercentage: string
}

export type RewardsAllowlistActionValues = {
  enabled: boolean
}

export type RewardsDistributorAllowanceActionValues = {
  distributor: Address
  allowed: boolean
}

export type GovernanceQuorumActionValues = {
  quorum: string
}

export type GovernanceDelayActionValues = {
  blocks: string
}

export type GovernanceDelegateCallTargetActionValues = {
  target: Address
  allowed: boolean
}

export type GovernanceCancelProposalActionValues = {
  proposalId: string
}

export type OperationalRoleActionValues = {
  account: Address
  granted: boolean
}

export type ConstitutionalTransferActionValues = {
  successor: Address
}

export type MatchedGovernanceAction = {
  definition: MatchableGovernanceAction
  values: unknown
  actions: SafeAction[]
  startIndex: number
  consumed: number
}
