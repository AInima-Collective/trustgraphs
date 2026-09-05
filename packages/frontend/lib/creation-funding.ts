import { parseFinancialAmount } from './financial-state'
import {
  initialPolicyForCreation,
  initialPolicyProblem,
} from './proving-prepay'

/** Unfinished drafts are editable input; invalid values must never reach transaction builders. */
export function reviewCreationFunding(
  data: { prepayEth: string; maxPerRootUsd: string },
  effective: bigint
) {
  const parsed = parseFinancialAmount(data.prepayEth, 18)
  const problem =
    parsed.error || initialPolicyProblem(data.prepayEth, data.maxPerRootUsd)
  const prepay = parsed.amount ?? 0n
  return {
    prepay,
    problem,
    initialPolicy: initialPolicyForCreation(
      problem ? 0n : prepay,
      effective,
      data.maxPerRootUsd
    ),
  }
}
