import { decodeFunctionData, encodeFunctionData, isAddress, isHex } from 'viem'

import { isCall, isZeroValue, requiredAddress, targetMatches } from './shared'
import type {
  GovernanceActionDefinition,
  WeightedPriorRotationActionValues,
} from './types'
import { weightedPriorParamsControllerAbi } from '../weighted-prior/contracts'

const bytes32 = (value: string) =>
  value.length === 66 && isHex(value, { strict: true })

export const weightedPriorRotationAction: GovernanceActionDefinition<WeightedPriorRotationActionValues> =
  {
    key: 'rotate-weighted-prior',
    category: 'scoring',
    label: 'Change weighted starting shares',
    summary:
      'Propose a reviewed weighted-prior manifest for delayed activation.',
    encode: (values, context) => {
      if (!isAddress(values.controller)) {
        throw new Error(
          'Weighted parameters controller must be a valid address'
        )
      }
      if (
        !isHex(values.manifest, { strict: true }) ||
        values.manifest.length % 2
      ) {
        throw new Error('Weighted manifest must be valid byte-aligned hex')
      }
      if (!bytes32(values.metadataDigest)) {
        throw new Error('Weighted metadata digest must be 32-byte hex')
      }
      const controller = requiredAddress(
        context.weightedParamsController,
        'Weighted parameters controller'
      )
      if (controller.toLowerCase() !== values.controller.toLowerCase()) {
        throw new Error(
          'Weighted parameters controller does not match this network'
        )
      }
      return [
        {
          target: controller,
          value: '0',
          data: encodeFunctionData({
            abi: weightedPriorParamsControllerAbi,
            functionName: 'proposePrior',
            args: [values.manifest, values.metadataDigest],
          }),
          operation: 0,
          description: 'Propose the reviewed weighted starting shares',
        },
      ]
    },
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !targetMatches(action, context.weightedParamsController) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: weightedPriorParamsControllerAbi,
          data: action!.data,
        })
        if (decoded.functionName !== 'proposePrior') return null
        return {
          values: {
            controller: requiredAddress(
              context.weightedParamsController,
              'Weighted parameters controller'
            ),
            manifest: decoded.args[0],
            metadataDigest: decoded.args[1],
          },
          consumed: 1,
        }
      } catch {
        return null
      }
    },
  }

export const weightedPriorCancelAction: GovernanceActionDefinition<
  Record<string, never>
> = {
  key: 'cancel-weighted-prior',
  category: 'scoring',
  label: 'Cancel weighted starting shares',
  summary: 'Cancel the controller’s currently pending weighted-prior version.',
  danger: true,
  encode: (_values, context) => [
    {
      target: requiredAddress(
        context.weightedParamsController,
        'Weighted parameters controller'
      ),
      value: '0',
      data: encodeFunctionData({
        abi: weightedPriorParamsControllerAbi,
        functionName: 'cancelPrior',
      }),
      operation: 0,
      description: 'Cancel the pending weighted starting shares',
    },
  ],
  match: (actions, index, context) => {
    const action = actions[index]
    if (
      !targetMatches(action, context.weightedParamsController) ||
      !isCall(action) ||
      !isZeroValue(action)
    ) {
      return null
    }
    try {
      const decoded = decodeFunctionData({
        abi: weightedPriorParamsControllerAbi,
        data: action!.data,
      })
      return decoded.functionName === 'cancelPrior'
        ? { values: {}, consumed: 1 }
        : null
    } catch {
      return null
    }
  },
}
