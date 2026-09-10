import {
  type Hex,
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  zeroAddress,
} from 'viem'

import {
  isCall,
  isZeroValue,
  requiredAddress,
  targetMatches,
  unsignedInteger,
} from './shared'
import type {
  GovernanceActionDefinition,
  VaultPolicyActionValues,
  VaultWithdrawalExecuteActionValues,
  VaultWithdrawalRequestActionValues,
} from './types'

const vaultActionAbi = parseAbi([
  'function setPolicy(bytes32 instanceId,uint64 minPaidIntervalBlocks,uint96 maxPerRootUsd)',
  'function requestWithdrawal(bytes32 instanceId,uint256 ethAmount,uint256 usdcAmount)',
  'function cancelWithdrawal(bytes32 instanceId)',
  'function executeWithdrawal(bytes32 instanceId,address to)',
])

const UINT64_MAX = (1n << 64n) - 1n
const UINT96_MAX = (1n << 96n) - 1n

const requiredInstanceId = (value: Hex | undefined): Hex => {
  if (!value || value.length !== 66) {
    throw new Error('Network instance id is not available for this network')
  }
  return value
}

const vaultCall = (
  actions: Parameters<GovernanceActionDefinition<unknown>['match']>[0],
  index: number,
  context: Parameters<GovernanceActionDefinition<unknown>['match']>[2]
) => {
  const action = actions[index]
  return targetMatches(action, context.provingVault) &&
    isCall(action) &&
    isZeroValue(action)
    ? action
    : null
}

export const vaultPolicyAction: GovernanceActionDefinition<VaultPolicyActionValues> =
  {
    key: 'set-vault-policy',
    category: 'vault',
    label: 'Set proving-vault policy',
    summary: 'Set the paid-root cadence and maximum payout for this network.',
    encode: (values, context) => [
      {
        target: requiredAddress(context.provingVault, 'Proving vault'),
        value: '0',
        data: encodeFunctionData({
          abi: vaultActionAbi,
          functionName: 'setPolicy',
          args: [
            requiredInstanceId(context.instanceId),
            unsignedInteger(values.minPaidIntervalBlocks, 'Paid interval', {
              max: UINT64_MAX,
            }),
            unsignedInteger(values.maxPerRootUsd, 'Maximum payout', {
              max: UINT96_MAX,
            }),
          ],
        }),
        operation: 0,
        description: 'Update the proving-vault payout policy',
      },
    ],
    match: (actions, index, context) => {
      const action = vaultCall(actions, index, context)
      if (!action || !context.instanceId) return null
      try {
        const decoded = decodeFunctionData({
          abi: vaultActionAbi,
          data: action.data,
        })
        if (
          decoded.functionName !== 'setPolicy' ||
          decoded.args[0].toLowerCase() !== context.instanceId.toLowerCase()
        ) {
          return null
        }
        return {
          values: {
            minPaidIntervalBlocks: decoded.args[1].toString(),
            maxPerRootUsd: decoded.args[2].toString(),
          },
          consumed: 1,
        }
      } catch {
        return null
      }
    },
  }

export const vaultWithdrawalRequestAction: GovernanceActionDefinition<VaultWithdrawalRequestActionValues> =
  {
    key: 'request-vault-withdrawal',
    category: 'vault',
    label: 'Request proving-vault withdrawal',
    summary: 'Start the notice period for withdrawing network proving funds.',
    danger: true,
    encode: (values, context) => {
      const ethAmount = unsignedInteger(values.ethAmount, 'ETH amount')
      const usdcAmount = unsignedInteger(values.usdcAmount, 'USDC amount')
      if (ethAmount === 0n && usdcAmount === 0n) {
        throw new Error('At least one withdrawal amount must be positive')
      }
      return [
        {
          target: requiredAddress(context.provingVault, 'Proving vault'),
          value: '0',
          data: encodeFunctionData({
            abi: vaultActionAbi,
            functionName: 'requestWithdrawal',
            args: [
              requiredInstanceId(context.instanceId),
              ethAmount,
              usdcAmount,
            ],
          }),
          operation: 0,
          description: 'Start the proving-fund withdrawal notice period',
        },
      ]
    },
    match: (actions, index, context) => {
      const action = vaultCall(actions, index, context)
      if (!action || !context.instanceId) return null
      try {
        const decoded = decodeFunctionData({
          abi: vaultActionAbi,
          data: action.data,
        })
        if (
          decoded.functionName !== 'requestWithdrawal' ||
          decoded.args[0].toLowerCase() !== context.instanceId.toLowerCase()
        ) {
          return null
        }
        return {
          values: {
            ethAmount: decoded.args[1].toString(),
            usdcAmount: decoded.args[2].toString(),
          },
          consumed: 1,
        }
      } catch {
        return null
      }
    },
  }

export const vaultWithdrawalCancelAction: GovernanceActionDefinition<
  Record<string, never>
> = {
  key: 'cancel-vault-withdrawal',
  category: 'vault',
  label: 'Cancel proving-vault withdrawal',
  summary: 'Keep the pending proving funds available for future roots.',
  encode: (_values, context) => [
    {
      target: requiredAddress(context.provingVault, 'Proving vault'),
      value: '0',
      data: encodeFunctionData({
        abi: vaultActionAbi,
        functionName: 'cancelWithdrawal',
        args: [requiredInstanceId(context.instanceId)],
      }),
      operation: 0,
      description: 'Cancel the pending proving-fund withdrawal',
    },
  ],
  match: (actions, index, context) => {
    const action = vaultCall(actions, index, context)
    if (!action || !context.instanceId) return null
    try {
      const decoded = decodeFunctionData({
        abi: vaultActionAbi,
        data: action.data,
      })
      return decoded.functionName === 'cancelWithdrawal' &&
        decoded.args[0].toLowerCase() === context.instanceId.toLowerCase()
        ? { values: {}, consumed: 1 }
        : null
    } catch {
      return null
    }
  },
}

export const vaultWithdrawalExecuteAction: GovernanceActionDefinition<VaultWithdrawalExecuteActionValues> =
  {
    key: 'execute-vault-withdrawal',
    category: 'vault',
    label: 'Execute proving-vault withdrawal',
    summary: 'Send the remaining requested proving funds to a recipient.',
    danger: true,
    encode: (values, context) => {
      if (values.recipient.toLowerCase() === zeroAddress) {
        throw new Error('Withdrawal recipient cannot be the zero address')
      }
      return [
        {
          target: requiredAddress(context.provingVault, 'Proving vault'),
          value: '0',
          data: encodeFunctionData({
            abi: vaultActionAbi,
            functionName: 'executeWithdrawal',
            args: [requiredInstanceId(context.instanceId), values.recipient],
          }),
          operation: 0,
          description: 'Execute the pending proving-fund withdrawal',
        },
      ]
    },
    match: (actions, index, context) => {
      const action = vaultCall(actions, index, context)
      if (!action || !context.instanceId) return null
      try {
        const decoded = decodeFunctionData({
          abi: vaultActionAbi,
          data: action.data,
        })
        if (
          decoded.functionName !== 'executeWithdrawal' ||
          decoded.args[0].toLowerCase() !== context.instanceId.toLowerCase()
        ) {
          return null
        }
        return { values: { recipient: decoded.args[1] }, consumed: 1 }
      } catch {
        return null
      }
    },
  }
