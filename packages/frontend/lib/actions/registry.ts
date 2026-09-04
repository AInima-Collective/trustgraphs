import {
  compositionPolicyAction,
  compositionPolicyCancelAction,
} from './composition'
import { customAction } from './custom'
import {
  governanceCancelProposalAction,
  governanceDelegateCallTargetAction,
  governanceExecutionDelayAction,
  governanceQuorumAction,
  governanceVotingDelayAction,
  governanceVotingPeriodAction,
} from './governance'
import {
  cancelConstitutionalTransferAction,
  constitutionalTransferAction,
  operationalRoleAction,
} from './membership'
import { networkProfileAction } from './profile'
import { createContributionRoundAction } from './programs'
import {
  recoveryCancelAction,
  recoveryProposerAction,
  safeDisableModuleAction,
  safeEnableModuleAction,
  safeGuardAction,
  safeSwapOwnerAction,
  signerPauseAction,
  snapshotAccumulatorAction,
  snapshotAnchorRegistryAction,
  snapshotVerifierAction,
} from './safety'
import { scoringParamsAction, signerParamsAction } from './scoring'
import { ethTransferAction } from './transfer'
import {
  erc20TransferAction,
  rewardDistributionAction,
  rewardsAllowlistAction,
  rewardsDistributorAllowanceAction,
  rewardsFeePercentageAction,
  rewardsFeeRecipientAction,
  rewardsPauseAction,
} from './treasury'
import type {
  GovernanceActionContext,
  MatchableGovernanceAction,
  MatchedGovernanceAction,
  SafeAction,
} from './types'
import {
  vaultPolicyAction,
  vaultWithdrawalCancelAction,
  vaultWithdrawalExecuteAction,
  vaultWithdrawalRequestAction,
} from './vault'
import {
  weightedPriorCancelAction,
  weightedPriorRotationAction,
} from './weighted'

/** Specific matchers precede the raw escape hatch. First valid match wins. */
export const governanceActionRegistry: readonly MatchableGovernanceAction[] = [
  scoringParamsAction,
  signerParamsAction,
  networkProfileAction,
  signerPauseAction,
  snapshotVerifierAction,
  snapshotAccumulatorAction,
  snapshotAnchorRegistryAction,
  safeEnableModuleAction,
  safeDisableModuleAction,
  safeGuardAction,
  safeSwapOwnerAction,
  recoveryProposerAction,
  recoveryCancelAction,
  weightedPriorRotationAction,
  weightedPriorCancelAction,
  compositionPolicyAction,
  compositionPolicyCancelAction,
  vaultPolicyAction,
  vaultWithdrawalRequestAction,
  vaultWithdrawalCancelAction,
  vaultWithdrawalExecuteAction,
  createContributionRoundAction,
  rewardDistributionAction,
  rewardsPauseAction,
  rewardsFeeRecipientAction,
  rewardsFeePercentageAction,
  rewardsAllowlistAction,
  rewardsDistributorAllowanceAction,
  governanceQuorumAction,
  governanceVotingDelayAction,
  governanceVotingPeriodAction,
  governanceExecutionDelayAction,
  governanceDelegateCallTargetAction,
  governanceCancelProposalAction,
  operationalRoleAction,
  constitutionalTransferAction,
  cancelConstitutionalTransferAction,
  erc20TransferAction,
  ethTransferAction,
  customAction,
]

export const walkGovernanceActions = (
  actions: readonly SafeAction[],
  context: GovernanceActionContext,
  registry: readonly MatchableGovernanceAction[] = governanceActionRegistry
): MatchedGovernanceAction[] => {
  const matched: MatchedGovernanceAction[] = []
  let index = 0
  while (index < actions.length) {
    let entry: MatchedGovernanceAction | undefined
    for (const definition of registry) {
      const candidate = definition.match(actions, index, context)
      if (
        !candidate ||
        !Number.isSafeInteger(candidate.consumed) ||
        candidate.consumed < 1 ||
        index + candidate.consumed > actions.length
      ) {
        continue
      }
      entry = {
        definition,
        values: candidate.values,
        actions: actions.slice(index, index + candidate.consumed),
        startIndex: index,
        consumed: candidate.consumed,
      }
      break
    }
    if (!entry) {
      throw new Error(`No governance action matched transaction ${index}`)
    }
    matched.push(entry)
    index += entry.consumed
  }
  return matched
}
