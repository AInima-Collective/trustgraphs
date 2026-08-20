import type { Hex } from 'viem'

import type { WeightedApiAvailability, WeightedApiEntry } from './api'
import { availabilityDiagnosis } from './api'
import {
  type WeightedCreationFields,
  weightedCreateArgs,
  weightedCreatePayload,
  weightedRotationPayload,
} from './contracts'
import type { WeightedImportArtifacts } from './import'
import { weightedRotationDiff } from './preview'

export const BINARY_REDEPLOYMENT_NOTICE =
  "This makes a separate weighted network using the old network's starting accounts. The old network and its history stay unchanged."

export const createReview = (
  fields: WeightedCreationFields,
  artifacts: WeightedImportArtifacts
) => ({
  kind: 'new-weighted-instance' as const,
  args: weightedCreateArgs(fields, artifacts),
  calldata: weightedCreatePayload(fields, artifacts),
  manifest: artifacts.manifest,
  priorRoot: artifacts.priorRoot,
  manifestSha256: artifacts.manifestSha256,
  metadataDigest: artifacts.metadataDigest,
})

export const rotationReview = (
  current: WeightedApiEntry[],
  availability: WeightedApiAvailability,
  artifacts: WeightedImportArtifacts
) => {
  const unavailable = availabilityDiagnosis(availability)
  if (availability.status === 'unavailable') {
    throw new Error(unavailable ?? 'Current prior is unavailable.')
  }
  return {
    kind: 'timelocked-prior-rotation' as const,
    calldata: weightedRotationPayload(artifacts),
    manifest: artifacts.manifest,
    priorRoot: artifacts.priorRoot,
    manifestSha256: artifacts.manifestSha256,
    metadataDigest: artifacts.metadataDigest,
    diff: weightedRotationDiff(
      current.map((entry) => ({
        account: entry.account,
        normalizedWeight: BigInt(entry.normalizedWeight),
      })),
      artifacts
    ),
    warning: unavailable,
  }
}

export type WeightedWorkflowEvent =
  | { kind: 'create'; instanceId: Hex; version: bigint }
  | { kind: 'propose'; instanceId: Hex; version: bigint }
  | { kind: 'activate'; instanceId: Hex; version: bigint }

/** Tiny deterministic model used by the browser-flow fixture and reorg-safe API acceptance test. */
export const replayWeightedWorkflow = (events: WeightedWorkflowEvent[]) => {
  const versions = new Map<bigint, 'pending' | 'active' | 'superseded'>()
  for (const event of events) {
    if (event.kind === 'create') versions.set(event.version, 'active')
    if (event.kind === 'propose') versions.set(event.version, 'pending')
    if (event.kind === 'activate') {
      for (const [version, status] of versions) {
        if (status === 'active') versions.set(version, 'superseded')
      }
      versions.set(event.version, 'active')
    }
  }
  return versions
}
