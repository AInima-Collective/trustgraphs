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
  paramsController?: Address
  signerSyncModule?: Address
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

export type MatchedGovernanceAction = {
  definition: MatchableGovernanceAction
  values: unknown
  actions: SafeAction[]
  startIndex: number
  consumed: number
}
