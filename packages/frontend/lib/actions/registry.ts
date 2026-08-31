import { customAction } from './custom'
import { networkProfileAction } from './profile'
import { signerPauseAction } from './safety'
import { scoringParamsAction, signerParamsAction } from './scoring'
import { ethTransferAction } from './transfer'
import type {
  GovernanceActionContext,
  MatchableGovernanceAction,
  MatchedGovernanceAction,
  SafeAction,
} from './types'
import { weightedPriorRotationAction } from './weighted'

/** Specific matchers precede the raw escape hatch. First valid match wins. */
export const governanceActionRegistry: readonly MatchableGovernanceAction[] = [
  scoringParamsAction,
  signerParamsAction,
  networkProfileAction,
  signerPauseAction,
  weightedPriorRotationAction,
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
