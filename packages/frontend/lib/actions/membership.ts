import {
  decodeFunctionData,
  encodeFunctionData,
  isAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  stringToHex,
  zeroAddress,
} from 'viem'

import { isCall, isZeroValue, requiredAddress, targetMatches } from './shared'
import type {
  ConstitutionalTransferActionValues,
  GovernanceActionDefinition,
  OperationalRoleActionValues,
} from './types'

export const OPERATIONAL_ROLE = keccak256(stringToHex('OPERATIONAL_ROLE'))

const membershipAbi = parseAbi([
  'function grantRole(bytes32 role, address account)',
  'function revokeRole(bytes32 role, address account)',
  'function proposeConstitutionalTransfer(address successor)',
  'function cancelConstitutionalTransfer()',
])

const snapshotTarget = (address: `0x${string}` | undefined) =>
  requiredAddress(address, 'Network snapshot')

const validAccount = (value: string, label: string) => {
  if (!isAddress(value) || isAddressEqual(value, zeroAddress)) {
    throw new Error(`${label} must be a non-zero address`)
  }
  return value
}

export const operationalRoleAction: GovernanceActionDefinition<OperationalRoleActionValues> =
  {
    key: 'set-operational-role',
    category: 'membership',
    label: 'Grant or revoke operational role',
    summary: 'Change who may publish the network’s operational parameters.',
    encode: (values, context) => {
      const account = validAccount(values.account, 'Operational account')
      return [
        {
          target: snapshotTarget(context.snapshot),
          value: '0',
          data: encodeFunctionData({
            abi: membershipAbi,
            functionName: values.granted ? 'grantRole' : 'revokeRole',
            args: [OPERATIONAL_ROLE, account],
          }),
          operation: 0,
          description: `${values.granted ? 'Grant' : 'Revoke'} operational role ${account}`,
        },
      ]
    },
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !targetMatches(action, context.snapshot) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: membershipAbi,
          data: action!.data,
        })
        if (
          (decoded.functionName !== 'grantRole' &&
            decoded.functionName !== 'revokeRole') ||
          decoded.args[0] !== OPERATIONAL_ROLE
        ) {
          return null
        }
        return {
          values: {
            account: decoded.args[1],
            granted: decoded.functionName === 'grantRole',
          },
          consumed: 1,
        }
      } catch {
        return null
      }
    },
  }

export const constitutionalTransferAction: GovernanceActionDefinition<ConstitutionalTransferActionValues> =
  {
    key: 'propose-constitutional-transfer',
    category: 'membership',
    label: 'Propose constitutional transfer',
    summary:
      'Begin a two-step handoff of the network’s constitutional authority.',
    danger: true,
    encode: (values, context) => {
      const successor = validAccount(values.successor, 'Successor')
      if (
        context.treasurySafe &&
        isAddressEqual(successor, context.treasurySafe)
      ) {
        throw new Error(
          'The successor must differ from the current network Safe'
        )
      }
      return [
        {
          target: snapshotTarget(context.snapshot),
          value: '0',
          data: encodeFunctionData({
            abi: membershipAbi,
            functionName: 'proposeConstitutionalTransfer',
            args: [successor],
          }),
          operation: 0,
          description: `Propose constitutional authority transfer to ${successor}`,
        },
      ]
    },
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !targetMatches(action, context.snapshot) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: membershipAbi,
          data: action!.data,
        })
        return decoded.functionName === 'proposeConstitutionalTransfer'
          ? { values: { successor: decoded.args[0] }, consumed: 1 }
          : null
      } catch {
        return null
      }
    },
  }

export const cancelConstitutionalTransferAction: GovernanceActionDefinition<
  Record<string, never>
> = {
  key: 'cancel-constitutional-transfer',
  category: 'membership',
  label: 'Cancel constitutional transfer',
  summary: 'Stop the currently pending constitutional handoff.',
  danger: true,
  encode: (_values, context) => [
    {
      target: snapshotTarget(context.snapshot),
      value: '0',
      data: encodeFunctionData({
        abi: membershipAbi,
        functionName: 'cancelConstitutionalTransfer',
      }),
      operation: 0,
      description: 'Cancel the pending constitutional authority transfer',
    },
  ],
  match: (actions, index, context) => {
    const action = actions[index]
    if (
      !targetMatches(action, context.snapshot) ||
      !isCall(action) ||
      !isZeroValue(action)
    ) {
      return null
    }
    try {
      const decoded = decodeFunctionData({
        abi: membershipAbi,
        data: action!.data,
      })
      return decoded.functionName === 'cancelConstitutionalTransfer'
        ? { values: {}, consumed: 1 }
        : null
    } catch {
      return null
    }
  },
}
