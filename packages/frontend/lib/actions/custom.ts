import type { CustomActionValues, GovernanceActionDefinition } from './types'

export const customAction: GovernanceActionDefinition<CustomActionValues> = {
  key: 'custom',
  category: 'custom',
  label: 'Custom contract call',
  summary: 'Execute an unrecognized transaction with its raw details visible.',
  encode: (values) => [values],
  match: (actions, index) => {
    const action = actions[index]
    return action ? { values: action, consumed: 1 } : null
  },
}
