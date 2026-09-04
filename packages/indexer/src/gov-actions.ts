import type { SafeAction } from '../../frontend/lib/actions/types'

export type ContractProposalAction = Omit<
  SafeAction,
  'value' | 'operation' | 'description'
> & {
  value: bigint
  operation: number
  description: string
}

const safeOperation = (operation: number): SafeAction['operation'] => {
  if (operation !== 0 && operation !== 1) {
    throw new Error(`Unsupported Safe operation ${operation}`)
  }
  return operation
}

/** Preserve the complete on-chain action tuple while making bigint values JSON-safe. */
export const formatProposalActions = (
  actions: readonly ContractProposalAction[]
): SafeAction[] =>
  actions.map((action) => ({
    target: action.target,
    value: action.value.toString(),
    data: action.data,
    operation: safeOperation(action.operation),
    description: action.description,
  }))
