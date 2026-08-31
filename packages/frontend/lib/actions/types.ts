import type { Address, Hex } from 'viem'

import type { Params } from '../pagerank/types'

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
  snapshot?: Address
  paramsController?: Address
  signerSyncModule?: Address
  weightedParamsController?: Address
  treasurySafe?: Address
  fundDistributor?: Address
  governanceModule?: Address
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
