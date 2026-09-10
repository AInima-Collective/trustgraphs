import { decodeFunctionData, encodeFunctionData } from 'viem'

import { isCall, isZeroValue, requiredAddress, targetMatches } from './shared'
import type {
  CompositionPolicyActionValues,
  GovernanceActionDefinition,
} from './types'
import { trustComposeParamsControllerAbi } from '../composition/contracts'

export const compositionPolicyAction: GovernanceActionDefinition<CompositionPolicyActionValues> =
  {
    key: 'propose-composition-policy',
    category: 'scoring',
    label: 'Change composition policy',
    summary:
      'Propose reviewed source weights and adapters for delayed activation.',
    encode: (values, context) => [
      {
        target: requiredAddress(
          context.compositionParamsController,
          'Composition policy controller'
        ),
        value: '0',
        data: encodeFunctionData({
          abi: trustComposeParamsControllerAbi,
          functionName: 'proposePolicy',
          args: [values.manifest, values.adapters, values.metadataDigest],
        }),
        operation: 0,
        description: 'Propose the reviewed composition source policy',
      },
    ],
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !targetMatches(action, context.compositionParamsController) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: trustComposeParamsControllerAbi,
          data: action!.data,
        })
        if (decoded.functionName !== 'proposePolicy') return null
        return {
          values: {
            manifest: decoded.args[0],
            adapters: [...decoded.args[1]],
            metadataDigest: decoded.args[2],
          },
          consumed: 1,
        }
      } catch {
        return null
      }
    },
  }

export const compositionPolicyCancelAction: GovernanceActionDefinition<
  Record<string, never>
> = {
  key: 'cancel-composition-policy',
  category: 'scoring',
  label: 'Cancel composition policy',
  summary: 'Cancel the controller’s currently pending composition policy.',
  danger: true,
  encode: (_values, context) => [
    {
      target: requiredAddress(
        context.compositionParamsController,
        'Composition policy controller'
      ),
      value: '0',
      data: encodeFunctionData({
        abi: trustComposeParamsControllerAbi,
        functionName: 'cancelPolicy',
      }),
      operation: 0,
      description: 'Cancel the pending composition policy',
    },
  ],
  match: (actions, index, context) => {
    const action = actions[index]
    if (
      !targetMatches(action, context.compositionParamsController) ||
      !isCall(action) ||
      !isZeroValue(action)
    ) {
      return null
    }
    try {
      const decoded = decodeFunctionData({
        abi: trustComposeParamsControllerAbi,
        data: action!.data,
      })
      return decoded.functionName === 'cancelPolicy'
        ? { values: {}, consumed: 1 }
        : null
    } catch {
      return null
    }
  },
}
