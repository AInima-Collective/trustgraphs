import { decodeFunctionData, encodeFunctionData, parseAbi } from 'viem'

import { isCall, isZeroValue, requiredAddress, targetMatches } from './shared'
import type {
  GovernanceActionDefinition,
  RecoveryCancelActionValues,
  SafeDisableModuleActionValues,
  SafeSwapOwnerActionValues,
  SafetyAddressActionValues,
  SignerPauseActionValues,
} from './types'

const signerPauseAbi = parseAbi(['function setPaused(bool paused)'])

const safetyAbi = parseAbi([
  'function setZkVerifier(address verifier)',
  'function setAccumulator(address accumulator)',
  'function setAnchorRegistry(address anchorRegistry)',
  'function enableModule(address module)',
  'function disableModule(address prevModule,address module)',
  'function setGuard(address guard)',
  'function swapOwner(address prevOwner,address oldOwner,address newOwner)',
])

const recoveryAbi = parseAbi([
  'function setProposer(address newProposer)',
  'function cancel(bytes32 actionId)',
])

type AddressSafetySpec = {
  key: string
  label: string
  summary: string
  functionName:
    | 'setZkVerifier'
    | 'setAccumulator'
    | 'setAnchorRegistry'
    | 'enableModule'
    | 'setGuard'
  contextKey: 'snapshot' | 'treasurySafe'
}

const addressSafetyAction = (
  spec: AddressSafetySpec
): GovernanceActionDefinition<SafetyAddressActionValues> => ({
  key: spec.key,
  category: 'safety',
  label: spec.label,
  summary: spec.summary,
  danger: true,
  encode: (values, context) => [
    {
      target: requiredAddress(context[spec.contextKey], spec.contextKey),
      value: '0',
      data: encodeFunctionData({
        abi: safetyAbi,
        functionName: spec.functionName,
        args: [values.address],
      }),
      operation: 0,
      description: `${spec.label}: ${values.address}`,
    },
  ],
  match: (actions, index, context) => {
    const action = actions[index]
    if (
      !targetMatches(action, context[spec.contextKey]) ||
      !isCall(action) ||
      !isZeroValue(action)
    ) {
      return null
    }
    try {
      const decoded = decodeFunctionData({
        abi: safetyAbi,
        data: action!.data,
      })
      if (decoded.functionName !== spec.functionName) return null
      return {
        values: { address: decoded.args[0] },
        consumed: 1,
      }
    } catch {
      return null
    }
  },
})

export const snapshotVerifierAction = addressSafetyAction({
  key: 'set-snapshot-verifier',
  label: 'Set proof verifier',
  summary: 'Replace the contract that verifies this network’s score proofs.',
  functionName: 'setZkVerifier',
  contextKey: 'snapshot',
})

export const snapshotAccumulatorAction = addressSafetyAction({
  key: 'set-snapshot-accumulator',
  label: 'Set attestation accumulator',
  summary: 'Replace the authenticated input accumulator for score proofs.',
  functionName: 'setAccumulator',
  contextKey: 'snapshot',
})

export const snapshotAnchorRegistryAction = addressSafetyAction({
  key: 'set-snapshot-anchor-registry',
  label: 'Set anchor registry',
  summary: 'Replace the registry supplying this network’s anchored inputs.',
  functionName: 'setAnchorRegistry',
  contextKey: 'snapshot',
})

export const safeEnableModuleAction = addressSafetyAction({
  key: 'enable-safe-module',
  label: 'Enable Safe module',
  summary:
    'Give a module authority to execute transactions from the network Safe.',
  functionName: 'enableModule',
  contextKey: 'treasurySafe',
})

export const safeGuardAction = addressSafetyAction({
  key: 'set-safe-guard',
  label: 'Set Safe guard',
  summary: 'Replace or clear the guard that checks every Safe transaction.',
  functionName: 'setGuard',
  contextKey: 'treasurySafe',
})

export const safeDisableModuleAction: GovernanceActionDefinition<SafeDisableModuleActionValues> =
  {
    key: 'disable-safe-module',
    category: 'safety',
    label: 'Disable Safe module',
    summary: 'Remove one module’s authority from the network Safe.',
    danger: true,
    encode: (values, context) => [
      {
        target: requiredAddress(context.treasurySafe, 'Network Safe'),
        value: '0',
        data: encodeFunctionData({
          abi: safetyAbi,
          functionName: 'disableModule',
          args: [values.previousModule, values.module],
        }),
        operation: 0,
        description: `Disable Safe module ${values.module}`,
      },
    ],
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !targetMatches(action, context.treasurySafe) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: safetyAbi,
          data: action!.data,
        })
        if (decoded.functionName !== 'disableModule') return null
        return {
          values: {
            previousModule: decoded.args[0],
            module: decoded.args[1],
          },
          consumed: 1,
        }
      } catch {
        return null
      }
    },
  }

export const safeSwapOwnerAction: GovernanceActionDefinition<SafeSwapOwnerActionValues> =
  {
    key: 'swap-safe-owner',
    category: 'safety',
    label: 'Swap Safe owner',
    summary: 'Replace one owner in the network Safe’s linked owner list.',
    danger: true,
    encode: (values, context) => [
      {
        target: requiredAddress(context.treasurySafe, 'Network Safe'),
        value: '0',
        data: encodeFunctionData({
          abi: safetyAbi,
          functionName: 'swapOwner',
          args: [values.previousOwner, values.oldOwner, values.newOwner],
        }),
        operation: 0,
        description: `Replace Safe owner ${values.oldOwner} with ${values.newOwner}`,
      },
    ],
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !targetMatches(action, context.treasurySafe) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: safetyAbi,
          data: action!.data,
        })
        if (decoded.functionName !== 'swapOwner') return null
        return {
          values: {
            previousOwner: decoded.args[0],
            oldOwner: decoded.args[1],
            newOwner: decoded.args[2],
          },
          consumed: 1,
        }
      } catch {
        return null
      }
    },
  }

export const recoveryProposerAction: GovernanceActionDefinition<SafetyAddressActionValues> =
  {
    key: 'set-recovery-proposer',
    category: 'safety',
    label: 'Rotate recovery proposer',
    summary:
      'Replace the identity allowed to schedule delayed recovery actions.',
    danger: true,
    encode: (values, context) => [
      {
        target: requiredAddress(context.recoveryModule, 'Recovery module'),
        value: '0',
        data: encodeFunctionData({
          abi: recoveryAbi,
          functionName: 'setProposer',
          args: [values.address],
        }),
        operation: 0,
        description: `Set recovery proposer to ${values.address}`,
      },
    ],
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !targetMatches(action, context.recoveryModule) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: recoveryAbi,
          data: action!.data,
        })
        return decoded.functionName === 'setProposer'
          ? { values: { address: decoded.args[0] }, consumed: 1 }
          : null
      } catch {
        return null
      }
    },
  }

export const recoveryCancelAction: GovernanceActionDefinition<RecoveryCancelActionValues> =
  {
    key: 'cancel-recovery-action',
    category: 'safety',
    label: 'Cancel recovery action',
    summary: 'Veto one exact action queued through delayed recovery.',
    danger: true,
    encode: (values, context) => [
      {
        target: requiredAddress(context.recoveryModule, 'Recovery module'),
        value: '0',
        data: encodeFunctionData({
          abi: recoveryAbi,
          functionName: 'cancel',
          args: [values.actionId],
        }),
        operation: 0,
        description: `Cancel queued recovery action ${values.actionId}`,
      },
    ],
    match: (actions, index, context) => {
      const action = actions[index]
      if (
        !targetMatches(action, context.recoveryModule) ||
        !isCall(action) ||
        !isZeroValue(action)
      ) {
        return null
      }
      try {
        const decoded = decodeFunctionData({
          abi: recoveryAbi,
          data: action!.data,
        })
        return decoded.functionName === 'cancel'
          ? { values: { actionId: decoded.args[0] }, consumed: 1 }
          : null
      } catch {
        return null
      }
    },
  }

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
