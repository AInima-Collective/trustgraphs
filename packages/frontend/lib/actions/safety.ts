import { decodeFunctionData, encodeFunctionData, parseAbi } from 'viem'

import { isCall, isZeroValue, requiredAddress, targetMatches } from './shared'
import type {
  GovernanceActionDefinition,
  SignerPauseActionValues,
} from './types'

const signerPauseAbi = parseAbi(['function setPaused(bool paused)'])

export const signerPauseAction: GovernanceActionDefinition<SignerPauseActionValues> =
  {
    key: 'set-signer-sync-paused',
    category: 'safety',
    label: 'Pause or resume signer sync',
    summary: 'Control whether new score-selected signer proofs may be applied.',
    encode: (values, context) => [
      {
        target: requiredAddress(context.signerSyncModule, 'Signer-sync module'),
        value: '0',
        data: encodeFunctionData({
          abi: signerPauseAbi,
          functionName: 'setPaused',
          args: [values.paused],
        }),
        operation: 0,
        description: `${values.paused ? 'Pause' : 'Resume'} signer synchronization`,
      },
    ],
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !targetMatches(action, context.signerSyncModule) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: signerPauseAbi,
          data: action!.data,
        })
        if (decoded.functionName !== 'setPaused') return null
        return { values: { paused: decoded.args[0] }, consumed: 1 }
      } catch {
        return null
      }
    },
  }
