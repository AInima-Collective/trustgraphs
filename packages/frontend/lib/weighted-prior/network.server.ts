import { type Hex, isHex } from 'viem'

import type { Network } from '../types'
import { fetchWeightedEntries, fetchWeightedInstance } from './api'
import { weightedInstanceToNetwork } from './network'

export const getWeightedNetwork = async (
  id: string,
  api: string,
  infrastructure: {
    provingVault?: Hex
    contributionsFactory?: Hex
  } = {}
): Promise<{ network?: Network; error: string | null }> => {
  if (!isHex(id) || id.length !== 66) return { error: null }

  try {
    const instance = await fetchWeightedInstance(api, id)
    const entries = await fetchWeightedEntries(
      api,
      instance.id,
      instance.currentVersion
    )
    return {
      network: weightedInstanceToNetwork(instance, entries, infrastructure),
      error: null,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // A miss is expected while `/networks/[id]` tries the isolated weighted catalog after the
    // ordinary trust-graph catalog. Other failures must remain distinguishable from not-found.
    if (/not found|\(404\)/i.test(reason)) return { error: null }
    return { error: reason }
  }
}
