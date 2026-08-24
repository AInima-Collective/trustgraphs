import { type Hex, decodeFunctionData } from 'viem'

import {
  governedWeightedTrustgraphsFactoryAbi,
  weightedPriorParamsControllerAbi,
  weightedTrustgraphsFactoryAbi,
} from '../abis/weightedPrior'

/**
 * Recover the exact committed manifest from the public transaction input that carried it.
 * Creation has two supported outer calls: direct `createInstance`, or the governed wrapper's
 * `createGovernedInstance`. The wrapper calls the base factory internally, so decoding only the
 * transaction's top-level calldata as the base ABI rejects every governed creation selector.
 */
export const weightedManifestFromCalldata = (
  data: Hex,
  kind: 'create' | 'propose'
): Hex => {
  if (kind === 'propose') {
    const decoded = decodeFunctionData({
      abi: weightedPriorParamsControllerAbi,
      data,
    })
    if (decoded.functionName !== 'proposePrior') {
      throw new Error(
        `source transaction decoded as ${decoded.functionName}, expected weighted propose`
      )
    }
    return decoded.args[0]
  }

  for (const [abi, expected] of [
    [weightedTrustgraphsFactoryAbi, 'createInstance'],
    [governedWeightedTrustgraphsFactoryAbi, 'createGovernedInstance'],
  ] as const) {
    try {
      const decoded = decodeFunctionData({ abi, data }) as any
      if (decoded.functionName === expected) {
        return decoded.args[0].manifest as Hex
      }
    } catch {
      // The selector belongs to the other supported creation seam; try it next.
    }
  }

  throw new Error(
    `source transaction selector ${data.slice(0, 10)} is not a weighted createInstance or createGovernedInstance call`
  )
}
