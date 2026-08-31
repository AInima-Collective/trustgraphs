import {
  decodeFunctionData,
  encodeFunctionData,
  isAddress,
  isAddressEqual,
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
  GovernanceCancelProposalActionValues,
  GovernanceDelayActionValues,
  GovernanceDelegateCallTargetActionValues,
  GovernanceQuorumActionValues,
} from './types'

const QUORUM_RANGE = 10n ** 18n

const governanceSettingsAbi = parseAbi([
  'function setQuorum(uint256 newQuorum)',
  'function setVotingDelay(uint256 newDelay)',
  'function setVotingPeriod(uint256 newPeriod)',
  'function setExecutionDelay(uint256 newDelay)',
  'function setDelegateCallTarget(address target, bool allowed)',
  'function cancel(uint256 proposalId)',
])

const moduleTarget = (address: `0x${string}` | undefined) =>
  requiredAddress(address, 'Governance module')

const delayDefinition = (
  key: string,
  label: string,
  summary: string,
  functionName: 'setVotingDelay' | 'setVotingPeriod' | 'setExecutionDelay',
  positive: boolean
): GovernanceActionDefinition<GovernanceDelayActionValues> => ({
  key,
  category: 'governance',
  label,
  summary,
  encode: (values, context) => {
    const blocks = unsignedInteger(values.blocks, `${label} blocks`, {
      positive,
    })
    return [
      {
        target: moduleTarget(context.governanceModule),
        value: '0',
        data: encodeFunctionData({
          abi: governanceSettingsAbi,
          functionName,
          args: [blocks],
        }),
        operation: 0,
        description: `${label}: ${blocks} blocks`,
      },
    ]
  },
  match: (actions, index, context) => {
    const action = actions[index]
    if (
      !targetMatches(action, context.governanceModule) ||
      !isCall(action) ||
      !isZeroValue(action)
    ) {
      return null
    }
    try {
      const decoded = decodeFunctionData({
        abi: governanceSettingsAbi,
        data: action!.data,
      })
      if (decoded.functionName !== functionName) return null
      return {
        values: { blocks: decoded.args[0].toString() },
        consumed: 1,
      }
    } catch {
      return null
    }
  },
})

export const governanceQuorumAction: GovernanceActionDefinition<GovernanceQuorumActionValues> =
  {
    key: 'set-governance-quorum',
    category: 'governance',
    label: 'Set governance quorum',
    summary: 'Set the decisive voting power required for proposals.',
    encode: (values, context) => {
      const quorum = unsignedInteger(values.quorum, 'Quorum', {
        positive: true,
        max: QUORUM_RANGE,
      })
      return [
        {
          target: moduleTarget(context.governanceModule),
          value: '0',
          data: encodeFunctionData({
            abi: governanceSettingsAbi,
            functionName: 'setQuorum',
            args: [quorum],
          }),
          operation: 0,
          description: `Set governance quorum to ${quorum} / ${QUORUM_RANGE}`,
        },
      ]
    },
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !targetMatches(action, context.governanceModule) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: governanceSettingsAbi,
          data: action!.data,
        })
        return decoded.functionName === 'setQuorum'
          ? { values: { quorum: decoded.args[0].toString() }, consumed: 1 }
          : null
      } catch {
        return null
      }
    },
  }

export const governanceVotingDelayAction = delayDefinition(
  'set-governance-voting-delay',
  'Set voting delay',
  'Set how many blocks pass before voting opens.',
  'setVotingDelay',
  false
)

export const governanceVotingPeriodAction = delayDefinition(
  'set-governance-voting-period',
  'Set voting period',
  'Set how many blocks voting remains open.',
  'setVotingPeriod',
  true
)

export const governanceExecutionDelayAction = delayDefinition(
  'set-governance-execution-delay',
  'Set execution delay',
  'Set how many blocks passed proposals wait before execution.',
  'setExecutionDelay',
  false
)

export const governanceDelegateCallTargetAction: GovernanceActionDefinition<GovernanceDelegateCallTargetActionValues> =
  {
    key: 'set-governance-delegatecall-target',
    category: 'governance',
    label: 'Update delegatecall allowlist',
    summary: 'Allow or revoke one delegatecall target for proposals.',
    danger: true,
    encode: (values, context) => {
      if (
        !isAddress(values.target) ||
        isAddressEqual(values.target, zeroAddress)
      ) {
        throw new Error('Delegatecall target must be a non-zero address')
      }
      return [
        {
          target: moduleTarget(context.governanceModule),
          value: '0',
          data: encodeFunctionData({
            abi: governanceSettingsAbi,
            functionName: 'setDelegateCallTarget',
            args: [values.target, values.allowed],
          }),
          operation: 0,
          description: `${values.allowed ? 'Allow' : 'Revoke'} delegatecall target ${values.target}`,
        },
      ]
    },
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !targetMatches(action, context.governanceModule) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: governanceSettingsAbi,
          data: action!.data,
        })
        return decoded.functionName === 'setDelegateCallTarget'
          ? {
              values: { target: decoded.args[0], allowed: decoded.args[1] },
              consumed: 1,
            }
          : null
      } catch {
        return null
      }
    },
  }

export const governanceCancelProposalAction: GovernanceActionDefinition<GovernanceCancelProposalActionValues> =
  {
    key: 'cancel-governance-proposal',
    category: 'governance',
    label: 'Cancel a proposal',
    summary: 'Cancel one existing, unexecuted governance proposal.',
    danger: true,
    encode: (values, context) => {
      const proposalId = unsignedInteger(values.proposalId, 'Proposal ID', {
        positive: true,
      })
      return [
        {
          target: moduleTarget(context.governanceModule),
          value: '0',
          data: encodeFunctionData({
            abi: governanceSettingsAbi,
            functionName: 'cancel',
            args: [proposalId],
          }),
          operation: 0,
          description: `Cancel governance proposal ${proposalId}`,
        },
      ]
    },
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !targetMatches(action, context.governanceModule) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: governanceSettingsAbi,
          data: action!.data,
        })
        return decoded.functionName === 'cancel'
          ? {
              values: { proposalId: decoded.args[0].toString() },
              consumed: 1,
            }
          : null
      } catch {
        return null
      }
    },
  }
