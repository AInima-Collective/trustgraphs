export type ContractProposalAction = {
  target: string
  value: bigint
  data: string
  operation: number
  description: string
}

export type ProposalAction = {
  target: string
  value: string
  data: string
  operation: number
  description: string
}

/** Preserve the complete on-chain action tuple while making bigint values JSON-safe. */
export const formatProposalActions = (
  actions: readonly ContractProposalAction[]
): ProposalAction[] =>
  actions.map((action) => ({
    target: action.target,
    value: action.value.toString(),
    data: action.data,
    operation: action.operation,
    description: action.description,
  }))
