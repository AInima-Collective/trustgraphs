import { isAddress } from 'viem'

import type {
  EthTransferActionValues,
  GovernanceActionDefinition,
} from './types'

const positiveValue = (value: string) => {
  try {
    return BigInt(value) > 0n
  } catch {
    return false
  }
}

export const ethTransferAction: GovernanceActionDefinition<EthTransferActionValues> =
  {
    key: 'send-eth',
    category: 'treasury',
    label: 'Send ETH',
    summary: 'Transfer ETH from the network Safe.',
    encode: (values) => {
      if (!isAddress(values.recipient)) {
        throw new Error('ETH recipient must be a valid address')
      }
      if (!positiveValue(values.value)) {
        throw new Error('ETH transfer value must be positive')
      }
      return [
        {
          target: values.recipient,
          value: values.value,
          data: '0x',
          operation: 0,
          description: values.description,
        },
      ]
    },
    match: (actions, index) => {
      const action = actions[index]
      if (
        !action ||
        action.operation !== 0 ||
        action.data !== '0x' ||
        !positiveValue(action.value)
      ) {
        return null
      }
      return {
        values: {
          recipient: action.target,
          value: action.value,
          description: action.description,
        },
        consumed: 1,
      }
    },
  }
