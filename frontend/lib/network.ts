import { formatUnits } from 'viem'

import { Network } from './types'
import { isHexEqual } from './utils'

export const isTrustedSeed = ({ pagerank }: Network, address: string) =>
  pagerank.trustedSeeds.some((seed) => isHexEqual(seed, address))

// Scores are pool allocations in wei (scaled by precisionScale = 1e18); compare in human units so
// `validatedThreshold` is expressed in whole tokens, not wei.
export const isValidatedInNetwork = (
  { validatedThreshold }: Network,
  value: string | number
) => Number(formatUnits(BigInt(Math.trunc(Number(value))), 18)) >= validatedThreshold
