import {
  type Address,
  decodeFunctionData,
  encodeFunctionData,
  isAddress,
  zeroAddress,
} from 'viem'

import {
  contributionsCreateArgs,
  contributionsFactoryAbi,
} from '../contributions-factory'
import {
  isCall,
  isZeroValue,
  requiredAddress,
  targetMatches,
  unsignedInteger,
} from './shared'
import type {
  ContributionRoundActionValues,
  GovernanceActionDefinition,
} from './types'

const UINT32_MAX = (1n << 32n) - 1n

export const createContributionRoundAction: GovernanceActionDefinition<ContributionRoundActionValues> =
  {
    key: 'create-contribution-round',
    category: 'programs',
    label: 'Create contribution round',
    summary:
      'Create a child funding round attached to this authenticated parent network.',
    encode: (values, context) => {
      if (!context.instanceId) {
        throw new Error('Network instance id is not available for this network')
      }
      if (!values.parentParams || values.parentEpochLength === undefined) {
        throw new Error(
          'The parent network’s exact indexed parameters are required'
        )
      }
      if (!values.name.trim()) throw new Error('Round name is required')
      if (!isAddress(values.distributorToken)) {
        throw new Error('Payout token must be a valid address')
      }
      const args = contributionsCreateArgs(
        context.instanceId,
        values.parentParams,
        unsignedInteger(values.parentEpochLength, 'Parent epoch length'),
        {
          name: values.name,
          roundStart: unsignedInteger(values.roundStart, 'Round start'),
          roundEnd: unsignedInteger(values.roundEnd, 'Round end'),
          totalPool: unsignedInteger(values.totalPool, 'Round pool', {
            positive: true,
          }),
          evaluatorCarveoutBps: Number(
            unsignedInteger(values.evaluatorCarveoutBps, 'Rater reward', {
              max: UINT32_MAX,
            })
          ),
          distributorToken: values.distributorToken,
          salt: values.salt,
        }
      )
      if (args.params.roundStart >= args.params.roundEnd) {
        throw new Error('The round must close after it opens')
      }
      if (args.params.evaluatorCarveoutBps > 10_000) {
        throw new Error('Rater reward cannot exceed 10000 basis points')
      }
      return [
        {
          target: requiredAddress(
            context.contributionsFactory,
            'Contribution-round factory'
          ),
          value: '0',
          data: encodeFunctionData({
            abi: contributionsFactoryAbi,
            functionName: 'createInstance',
            args: [args],
          }),
          operation: 0,
          description: `Create contribution round “${args.name}”`,
        },
      ]
    },
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !context.instanceId ||
        !targetMatches(action, context.contributionsFactory) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: contributionsFactoryAbi,
          data: action!.data,
        })
        if (
          decoded.functionName !== 'createInstance' ||
          decoded.args[0].parentInstanceId.toLowerCase() !==
            context.instanceId.toLowerCase() ||
          decoded.args[0].admin.toLowerCase() !== zeroAddress
        ) {
          return null
        }
        const args = decoded.args[0]
        return {
          values: {
            name: args.name,
            roundStart: args.params.roundStart.toString(),
            roundEnd: args.params.roundEnd.toString(),
            totalPool: args.params.totalPool.toString(),
            evaluatorCarveoutBps: args.params.evaluatorCarveoutBps.toString(),
            distributorToken: args.distributorToken as Address,
            salt: args.salt,
          },
          consumed: 1,
        }
      } catch {
        return null
      }
    },
  }
