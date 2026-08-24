import { type Address, type Hex, decodeFunctionData } from 'viem'

import {
  governedTrustComposeFactoryAbi,
  trustComposeFactoryAbi,
  trustComposeParamsControllerAbi,
} from '../abis/composition'

export type CompositionPolicyCalldata = {
  manifest: Hex
  adapters: Address[]
}

/**
 * Recover the exact policy preimage from its public source transaction. Creation may be a direct
 * base-factory call or a governed-wrapper call; both carry the same CreateArgs as argument zero.
 */
export const compositionPolicyFromCalldata = (
  data: Hex,
  kind: 'create' | 'propose'
): CompositionPolicyCalldata => {
  if (kind === 'propose') {
    const decoded = decodeFunctionData({
      abi: trustComposeParamsControllerAbi,
      data,
    })
    if (decoded.functionName !== 'proposePolicy') {
      throw new Error(
        `source transaction decoded as ${decoded.functionName}, expected composition propose`
      )
    }
    return {
      manifest: decoded.args[0],
      adapters: [...decoded.args[1]],
    }
  }

  for (const [abi, expected] of [
    [trustComposeFactoryAbi, 'createInstance'],
    [governedTrustComposeFactoryAbi, 'createGovernedInstance'],
  ] as const) {
    try {
      const decoded = decodeFunctionData({ abi, data }) as any
      if (decoded.functionName === expected) {
        return {
          manifest: decoded.args[0].policyManifest as Hex,
          adapters: [...decoded.args[0].sourceAdapters] as Address[],
        }
      }
    } catch {
      // The selector belongs to the other supported creation seam; try it next.
    }
  }

  throw new Error(
    `source transaction selector ${data.slice(0, 10)} is not a composition createInstance or createGovernedInstance call`
  )
}
