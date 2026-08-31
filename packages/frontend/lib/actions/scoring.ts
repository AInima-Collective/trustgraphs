import { type Address, type Hex, encodeFunctionData } from 'viem'

import {
  buildParameterActions,
  decodeParameterUpdateAction,
  decodeSignerParamsHashAction,
  signerParamsAbi,
} from '../scoring-params'
import { isCall, isZeroValue, requiredAddress, targetMatches } from './shared'
import type {
  GovernanceActionDefinition,
  SafeAction,
  ScoringParamsActionValues,
  SignerParamsActionValues,
} from './types'

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const decodedSignerHash = (
  action: SafeAction | undefined,
  signerSyncModule: Address | undefined
): Hex | null => {
  if (
    !targetMatches(action, signerSyncModule) ||
    !isCall(action) ||
    !isZeroValue(action)
  ) {
    return null
  }
  return decodeSignerParamsHashAction(action!.data)
}

const decodedParamsUpdate = (
  action: SafeAction | undefined,
  paramsController: Address | undefined
) => {
  if (
    !targetMatches(action, paramsController) ||
    !isCall(action) ||
    !isZeroValue(action)
  ) {
    return null
  }
  return decodeParameterUpdateAction(action!.data)
}

export const scoringParamsAction: GovernanceActionDefinition<ScoringParamsActionValues> =
  {
    key: 'update-scoring-params',
    category: 'scoring',
    label: 'Update scoring parameters',
    summary: 'Publish a versioned scoring configuration for this network.',
    encode: (values, context) =>
      buildParameterActions({
        controller: requiredAddress(
          context.paramsController,
          'Scoring parameters controller'
        ),
        proposed: values.proposed,
        evidenceURI: values.evidenceURI,
        signerCompanion: values.syncSigner
          ? requiredAddress(context.signerSyncModule, 'Signer-sync module')
          : undefined,
      }),
    match: (actions, index, context) => {
      const first = actions[index]
      const signerHash = decodedSignerHash(first, context.signerSyncModule)
      if (signerHash) {
        const update = decodedParamsUpdate(
          actions[index + 1],
          context.paramsController
        )
        if (update && sameHex(signerHash, update.proposedHash)) {
          return {
            values: {
              proposed: update.proposed,
              evidenceURI: update.evidenceURI,
              syncSigner: true,
            },
            consumed: 2,
          }
        }
      }

      const update = decodedParamsUpdate(first, context.paramsController)
      return update
        ? {
            values: {
              proposed: update.proposed,
              evidenceURI: update.evidenceURI,
              syncSigner: false,
            },
            consumed: 1,
          }
        : null
    },
  }

export const signerParamsAction: GovernanceActionDefinition<SignerParamsActionValues> =
  {
    key: 'set-signer-params-hash',
    category: 'scoring',
    label: 'Synchronize signer rules',
    summary: 'Point signer selection at a reviewed scoring configuration.',
    encode: (values, context) => [
      {
        target: requiredAddress(context.signerSyncModule, 'Signer-sync module'),
        value: '0',
        data: encodeFunctionData({
          abi: signerParamsAbi,
          functionName: 'setParamsHash',
          args: [values.paramsHash],
        }),
        operation: 0,
        description: `Set the signer-sync companion to scoring hash ${values.paramsHash}`,
      },
    ],
    match: (actions, index, context) => {
      const paramsHash = decodedSignerHash(
        actions[index],
        context.signerSyncModule
      )
      return paramsHash ? { values: { paramsHash }, consumed: 1 } : null
    },
  }
