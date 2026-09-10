import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  isAddress,
  isAddressEqual,
  zeroAddress,
} from 'viem'

import { merkleFundDistributorAbi } from '../contract-abis'
import {
  isCall,
  isZeroValue,
  requiredAddress,
  targetMatches,
  unsignedInteger,
} from './shared'
import type {
  Erc20TransferActionValues,
  GovernanceActionContext,
  GovernanceActionDefinition,
  RewardDistributionActionValues,
  RewardsAllowlistActionValues,
  RewardsDistributorAllowanceActionValues,
  RewardsFeePercentageActionValues,
  RewardsFeeRecipientActionValues,
  RewardsPauseActionValues,
  SafeAction,
} from './types'

const FEE_RANGE = 10n ** 18n
const UINT64_MAX = (1n << 64n) - 1n

const address = (value: string, label: string) => {
  if (!isAddress(value)) throw new Error(`${label} must be a valid address`)
  return value
}

const nonZeroAddress = (value: string, label: string) => {
  const parsed = address(value, label)
  if (isAddressEqual(parsed, zeroAddress)) {
    throw new Error(`${label} must be a non-zero address`)
  }
  return parsed
}

const trustedDistributor = (context: GovernanceActionContext) =>
  requiredAddress(context.fundDistributor, 'Rewards distributor')

export const erc20TransferAction: GovernanceActionDefinition<Erc20TransferActionValues> =
  {
    key: 'send-erc20',
    category: 'treasury',
    label: 'Send ERC-20',
    summary: 'Call transfer on a token contract from the network Safe.',
    encode: (values) => {
      const token = nonZeroAddress(values.token, 'Token contract')
      const recipient = nonZeroAddress(values.recipient, 'Token recipient')
      const amount = unsignedInteger(values.amount, 'Token amount', {
        positive: true,
      })
      return [
        {
          target: token,
          value: '0',
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [recipient, amount],
          }),
          operation: 0,
          description: `Transfer ${amount} token base units to ${recipient}`,
        },
      ]
    },
    match: (actions, index) => {
      // ERC-20 assets are proposal-selected external contracts, not network-owned contracts that
      // can be authenticated through GovernanceActionContext. Never infer a symbol or identity:
      // the viewer presents this as an exact `transfer`-shaped call and surfaces the target.
      const action = actions[index]
      if (
        !action ||
        !isCall(action) ||
        !isZeroValue(action) ||
        isAddressEqual(action.target, zeroAddress)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({ abi: erc20Abi, data: action.data })
        if (decoded.functionName !== 'transfer') return null
        return {
          values: {
            token: action.target,
            recipient: decoded.args[0],
            amount: decoded.args[1].toString(),
          },
          consumed: 1,
        }
      } catch {
        return null
      }
    },
  }

const decodeDistribution = (
  action: SafeAction | undefined,
  context: GovernanceActionContext
): RewardDistributionActionValues | null => {
  if (!targetMatches(action, context.fundDistributor) || !isCall(action)) {
    return null
  }
  try {
    const decoded = decodeFunctionData({
      abi: merkleFundDistributorAbi,
      data: action!.data,
    })
    if (decoded.functionName !== 'distribute') return null
    const [
      token,
      amount,
      expectedRoot,
      expectedTotalMerkleValue,
      claimDeadline,
      maxFeeAmount,
      expectedFeeRecipient,
    ] = decoded.args
    const suppliedValue = BigInt(action!.value)
    if (
      (isAddressEqual(token, zeroAddress) && suppliedValue !== amount) ||
      (!isAddressEqual(token, zeroAddress) && suppliedValue !== 0n)
    ) {
      return null
    }
    return {
      token,
      amount: amount.toString(),
      expectedRoot,
      expectedTotalMerkleValue: expectedTotalMerkleValue.toString(),
      claimDeadline: claimDeadline.toString(),
      maxFeeAmount: maxFeeAmount.toString(),
      expectedFeeRecipient,
    }
  } catch {
    return null
  }
}

export const rewardDistributionAction: GovernanceActionDefinition<RewardDistributionActionValues> =
  {
    key: 'fund-rewards',
    category: 'treasury',
    label: 'Fund network rewards',
    summary: 'Fund a distribution against one exact proven score root.',
    encode: (values, context) => {
      const distributor = trustedDistributor(context)
      const token = address(values.token, 'Reward token')
      const amount = unsignedInteger(values.amount, 'Reward amount', {
        positive: true,
      })
      const total = unsignedInteger(
        values.expectedTotalMerkleValue,
        'Expected total score',
        { positive: true }
      )
      const deadline = unsignedInteger(values.claimDeadline, 'Claim deadline', {
        max: UINT64_MAX,
      })
      const maxFee = unsignedInteger(values.maxFeeAmount, 'Maximum fee')
      const feeRecipient = nonZeroAddress(
        values.expectedFeeRecipient,
        'Expected fee recipient'
      )
      if (
        values.expectedRoot.length !== 66 ||
        !/^0x[0-9a-fA-F]{64}$/.test(values.expectedRoot) ||
        /^0x0{64}$/.test(values.expectedRoot)
      ) {
        throw new Error('Expected score root must be non-zero 32-byte hex')
      }
      const distribution: SafeAction = {
        target: distributor,
        value: isAddressEqual(token, zeroAddress) ? amount.toString() : '0',
        data: encodeFunctionData({
          abi: merkleFundDistributorAbi,
          functionName: 'distribute',
          args: [
            token,
            amount,
            values.expectedRoot,
            total,
            deadline,
            maxFee,
            feeRecipient,
          ],
        }),
        operation: 0,
        description: `Fund rewards with ${amount} base units against ${values.expectedRoot}`,
      }
      if (isAddressEqual(token, zeroAddress)) return [distribution]
      return [
        {
          target: token,
          value: '0',
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [distributor, amount],
          }),
          operation: 0,
          description: `Approve ${amount} token base units for the rewards distributor`,
        },
        distribution,
      ]
    },
    match: (actions, index, context) => {
      const direct = decodeDistribution(actions[index], context)
      if (direct && isAddressEqual(direct.token, zeroAddress)) {
        return { values: direct, consumed: 1 }
      }

      const approval = actions[index]
      const distribution = decodeDistribution(actions[index + 1], context)
      if (
        !approval ||
        !distribution ||
        isAddressEqual(distribution.token, zeroAddress) ||
        !isCall(approval) ||
        !isZeroValue(approval) ||
        !isAddressEqual(approval.target, distribution.token)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: erc20Abi,
          data: approval.data,
        })
        if (
          decoded.functionName !== 'approve' ||
          !context.fundDistributor ||
          !isAddressEqual(decoded.args[0], context.fundDistributor) ||
          decoded.args[1].toString() !== distribution.amount
        ) {
          return null
        }
        return { values: distribution, consumed: 2 }
      } catch {
        return null
      }
    },
  }

export const rewardsPauseAction: GovernanceActionDefinition<RewardsPauseActionValues> =
  {
    key: 'set-rewards-paused',
    category: 'treasury',
    label: 'Pause or resume rewards',
    summary: 'Control new reward funding and claims.',
    encode: (values, context) => [
      {
        target: trustedDistributor(context),
        value: '0',
        data: encodeFunctionData({
          abi: merkleFundDistributorAbi,
          functionName: values.paused ? 'pause' : 'unpause',
        }),
        operation: 0,
        description: `${values.paused ? 'Pause' : 'Resume'} reward distributions and claims`,
      },
    ],
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !targetMatches(action, context.fundDistributor) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: merkleFundDistributorAbi,
          data: action!.data,
        })
        if (decoded.functionName === 'pause') {
          return { values: { paused: true }, consumed: 1 }
        }
        if (decoded.functionName === 'unpause') {
          return { values: { paused: false }, consumed: 1 }
        }
        return null
      } catch {
        return null
      }
    },
  }

export const rewardsFeeRecipientAction: GovernanceActionDefinition<RewardsFeeRecipientActionValues> =
  {
    key: 'set-rewards-fee-recipient',
    category: 'treasury',
    label: 'Set rewards fee recipient',
    summary: 'Choose where distributor fees are paid.',
    encode: (values, context) => [
      {
        target: trustedDistributor(context),
        value: '0',
        data: encodeFunctionData({
          abi: merkleFundDistributorAbi,
          functionName: 'setFeeRecipient',
          args: [nonZeroAddress(values.recipient, 'Fee recipient')],
        }),
        operation: 0,
        description: `Set the rewards fee recipient to ${values.recipient}`,
      },
    ],
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !targetMatches(action, context.fundDistributor) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: merkleFundDistributorAbi,
          data: action!.data,
        })
        return decoded.functionName === 'setFeeRecipient'
          ? { values: { recipient: decoded.args[0] }, consumed: 1 }
          : null
      } catch {
        return null
      }
    },
  }

export const rewardsFeePercentageAction: GovernanceActionDefinition<RewardsFeePercentageActionValues> =
  {
    key: 'set-rewards-fee-percentage',
    category: 'treasury',
    label: 'Set rewards fee',
    summary: 'Set or schedule the distributor fee percentage.',
    encode: (values, context) => {
      const fee = unsignedInteger(values.feePercentage, 'Fee percentage', {
        max: FEE_RANGE,
      })
      return [
        {
          target: trustedDistributor(context),
          value: '0',
          data: encodeFunctionData({
            abi: merkleFundDistributorAbi,
            functionName: 'setFeePercentage',
            args: [fee],
          }),
          operation: 0,
          description: `Set the rewards fee to ${fee} / ${FEE_RANGE}`,
        },
      ]
    },
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !targetMatches(action, context.fundDistributor) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: merkleFundDistributorAbi,
          data: action!.data,
        })
        return decoded.functionName === 'setFeePercentage'
          ? {
              values: { feePercentage: decoded.args[0].toString() },
              consumed: 1,
            }
          : null
      } catch {
        return null
      }
    },
  }

export const rewardsAllowlistAction: GovernanceActionDefinition<RewardsAllowlistActionValues> =
  {
    key: 'set-rewards-allowlist-enabled',
    category: 'treasury',
    label: 'Enable or disable rewards allowlist',
    summary: 'Require funders to be individually allowlisted.',
    encode: (values, context) => [
      {
        target: trustedDistributor(context),
        value: '0',
        data: encodeFunctionData({
          abi: merkleFundDistributorAbi,
          functionName: 'setAllowlistEnabled',
          args: [values.enabled],
        }),
        operation: 0,
        description: `${values.enabled ? 'Enable' : 'Disable'} the rewards funder allowlist`,
      },
    ],
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !targetMatches(action, context.fundDistributor) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: merkleFundDistributorAbi,
          data: action!.data,
        })
        return decoded.functionName === 'setAllowlistEnabled'
          ? { values: { enabled: decoded.args[0] }, consumed: 1 }
          : null
      } catch {
        return null
      }
    },
  }

export const rewardsDistributorAllowanceAction: GovernanceActionDefinition<RewardsDistributorAllowanceActionValues> =
  {
    key: 'set-rewards-distributor-allowance',
    category: 'treasury',
    label: 'Update rewards funder allowance',
    summary: 'Allow or remove one address from funding rewards.',
    encode: (values, context) => [
      {
        target: trustedDistributor(context),
        value: '0',
        data: encodeFunctionData({
          abi: merkleFundDistributorAbi,
          functionName: 'updateDistributorAllowance',
          args: [
            nonZeroAddress(values.distributor, 'Funder address'),
            values.allowed,
          ],
        }),
        operation: 0,
        description: `${values.allowed ? 'Allow' : 'Remove'} rewards funder ${values.distributor}`,
      },
    ],
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !targetMatches(action, context.fundDistributor) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: merkleFundDistributorAbi,
          data: action!.data,
        })
        return decoded.functionName === 'updateDistributorAllowance'
          ? {
              values: {
                distributor: decoded.args[0],
                allowed: decoded.args[1],
              },
              consumed: 1,
            }
          : null
      } catch {
        return null
      }
    },
  }
