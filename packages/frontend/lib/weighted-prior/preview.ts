import { type Hex, zeroAddress } from 'viem'

import { type ComputeResult, type Params, compute } from './core'
import type { WeightedImportArtifacts } from './import'
import { type RawEdge } from '../pagerank/types'
import { ZERO_HASH } from '../pagerank/words'

export const WEIGHTED_PREVIEW_ALWAYS_ASYNC = true

export interface WeightedPreviewTuning {
  dampingFp: bigint
  toleranceFp: bigint
  maxIterations: number
  minWeight: bigint
  maxWeight: bigint
}

export const DEFAULT_WEIGHTED_TUNING: WeightedPreviewTuning = {
  dampingFp: 850_000_000_000_000_000n,
  toleranceFp: 0n,
  maxIterations: 40,
  minWeight: 0n,
  maxWeight: 100n,
}

export const previewParams = (
  artifacts: WeightedImportArtifacts,
  tuning: WeightedPreviewTuning = DEFAULT_WEIGHTED_TUNING
): Params => ({
  version: 1,
  ...tuning,
  priorRoot: artifacts.priorRoot,
  priorCount: artifacts.priorCount,
  manifestSha256: artifacts.manifestSha256,
  schemaUid: ZERO_HASH,
  weightFieldIndex: 1,
  accumulator: zeroAddress,
  chainId: artifacts.source.chainId,
})

/** Exact #52 computation; an empty edge set is the explicit prior-only day-zero preview. */
export const runWeightedPreview = (
  artifacts: WeightedImportArtifacts,
  edges: RawEdge[] = [],
  tuning: WeightedPreviewTuning = DEFAULT_WEIGHTED_TUNING
): ComputeResult =>
  compute({
    edges,
    params: previewParams(artifacts, tuning),
    manifest: artifacts.manifest,
    binding: { recipient: zeroAddress, instanceDomain: ZERO_HASH },
  })

export interface WeightedRotationDiff {
  added: Array<{ account: Hex; weight: bigint }>
  removed: Array<{ account: Hex; weight: bigint }>
  changed: Array<{
    account: Hex
    before: bigint
    after: bigint
    delta: bigint
  }>
}

export const weightedRotationDiff = (
  before: Array<{ account: Hex; normalizedWeight: bigint }>,
  after: WeightedImportArtifacts
): WeightedRotationDiff => {
  const old = new Map(
    before.map((entry) => [entry.account.toLowerCase(), entry.normalizedWeight])
  )
  const next = new Map(
    after.normalizedEntries.map((entry) => [
      entry.account.toLowerCase(),
      entry.weight,
    ])
  )
  const added = after.normalizedEntries
    .filter((entry) => !old.has(entry.account.toLowerCase()))
    .map((entry) => ({ account: entry.account, weight: entry.weight }))
  const removed = before
    .filter((entry) => !next.has(entry.account.toLowerCase()))
    .map((entry) => ({
      account: entry.account,
      weight: entry.normalizedWeight,
    }))
  const changed = after.normalizedEntries.flatMap((entry) => {
    const prior = old.get(entry.account.toLowerCase())
    return prior !== undefined && prior !== entry.weight
      ? [
          {
            account: entry.account,
            before: prior,
            after: entry.weight,
            delta: entry.weight - prior,
          },
        ]
      : []
  })
  return { added, removed, changed }
}
