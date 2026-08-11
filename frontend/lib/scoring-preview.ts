import type { Hex } from 'viem'

import { compute } from './pagerank/compute'
import { selectSigners } from './pagerank/signer'
import type { Params, RawEdge, SelectionParams } from './pagerank/types'

export type ScoreMove = {
  account: Hex
  current: bigint
  proposed: bigint
  delta: bigint
}

export type ScoringPreview = {
  currentHash: Hex
  proposedHash: Hex
  inputAcc: Hex
  inputCount: bigint
  currentRoot: Hex
  proposedRoot: Hex
  gained: number
  lost: number
  unchanged: number
  largestMovers: ScoreMove[]
  currentTrustedMassBps: number
  proposedTrustedMassBps: number
  currentTopTenMassBps: number
  proposedTopTenMassBps: number
  currentConverged: boolean
  proposedConverged: boolean
  currentIterations: number
  proposedIterations: number
  signerChange: null | {
    changed: boolean
    currentSigners: Hex[]
    proposedSigners: Hex[]
    currentThreshold: bigint
    proposedThreshold: bigint
  }
}

const asMap = (scores: Array<[Hex, bigint]>) =>
  new Map(scores.map(([account, value]) => [account.toLowerCase(), value]))

const massBps = (values: bigint[], total: bigint): number => {
  if (total <= 0n) return 0
  const mass = values.reduce((sum, value) => sum + value, 0n)
  return Number((mass * 10_000n) / total)
}

const trustedMassBps = (scores: Map<string, bigint>, seeds: readonly Hex[]) => {
  const total = Array.from(scores.values()).reduce(
    (sum, value) => sum + value,
    0n
  )
  return massBps(
    seeds.map((seed) => scores.get(seed.toLowerCase()) ?? 0n),
    total
  )
}

const topTenMassBps = (scores: Map<string, bigint>) => {
  const values = Array.from(scores.values()).sort((a, b) =>
    a === b ? 0 : a > b ? -1 : 1
  )
  return massBps(
    values.slice(0, 10),
    values.reduce((sum, value) => sum + value, 0n)
  )
}

/** Compare two exact tuples over one exact fold log using the parity-locked browser core. */
export const previewScoringChange = ({
  edges,
  current,
  proposed,
  signerSelection,
}: {
  edges: RawEdge[]
  current: Params
  proposed: Params
  signerSelection?: SelectionParams
}): ScoringPreview => {
  const before = compute({ edges, params: current })
  const after = compute({ edges, params: proposed })
  const beforeScores = asMap(before.scores)
  const afterScores = asMap(after.scores)
  const accounts = new Set([...beforeScores.keys(), ...afterScores.keys()])

  let gained = 0
  let lost = 0
  let unchanged = 0
  const moves: ScoreMove[] = []
  for (const account of accounts) {
    const currentScore = beforeScores.get(account) ?? 0n
    const proposedScore = afterScores.get(account) ?? 0n
    const delta = proposedScore - currentScore
    if (delta > 0n) gained++
    else if (delta < 0n) lost++
    else unchanged++
    moves.push({
      account: account as Hex,
      current: currentScore,
      proposed: proposedScore,
      delta,
    })
  }
  moves.sort((a, b) => {
    const aa = a.delta < 0n ? -a.delta : a.delta
    const bb = b.delta < 0n ? -b.delta : b.delta
    return aa === bb ? a.account.localeCompare(b.account) : aa > bb ? -1 : 1
  })

  const beforeSigners = signerSelection
    ? selectSigners(before.scores, signerSelection)
    : null
  const afterSigners = signerSelection
    ? selectSigners(after.scores, signerSelection)
    : null

  return {
    currentHash: before.journal.paramsHash,
    proposedHash: after.journal.paramsHash,
    inputAcc: before.journal.acc,
    inputCount: before.journal.leafCount,
    currentRoot: before.journal.outputRoot,
    proposedRoot: after.journal.outputRoot,
    gained,
    lost,
    unchanged,
    largestMovers: moves.slice(0, 20),
    currentTrustedMassBps: trustedMassBps(beforeScores, current.trustedSeeds),
    proposedTrustedMassBps: trustedMassBps(afterScores, proposed.trustedSeeds),
    currentTopTenMassBps: topTenMassBps(beforeScores),
    proposedTopTenMassBps: topTenMassBps(afterScores),
    currentConverged: before.rankDiagnostics.converged,
    proposedConverged: after.rankDiagnostics.converged,
    currentIterations: before.rankDiagnostics.iterations,
    proposedIterations: after.rankDiagnostics.iterations,
    signerChange:
      beforeSigners && afterSigners
        ? {
            changed:
              beforeSigners.threshold !== afterSigners.threshold ||
              beforeSigners.signers.join(',').toLowerCase() !==
                afterSigners.signers.join(',').toLowerCase(),
            currentSigners: beforeSigners.signers,
            proposedSigners: afterSigners.signers,
            currentThreshold: beforeSigners.threshold,
            proposedThreshold: afterSigners.threshold,
          }
        : null,
  }
}
