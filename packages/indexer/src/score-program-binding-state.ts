export type ScoreBindingIdentity = {
  instanceId: string
  programId: string
  outputDomain: string | null
  paramsHash: string
  conflict: boolean
  conflictReason: string | null
}

export type IncomingScoreBinding = {
  snapshot: string
  instanceId: string
  programId: string
  outputDomain: string | null
}

export type ScoreBindingDecision = { accepted: boolean; reason: string | null }

/** Pure fold rule: a snapshot's first known program/domain/instance identity is immutable. */
export const decideScoreBinding = (
  existing: ScoreBindingIdentity | undefined,
  incoming: IncomingScoreBinding
): ScoreBindingDecision => {
  if (!incoming.outputDomain) {
    return {
      accepted: false,
      reason: `unknown score program ${incoming.programId}`,
    }
  }
  if (!existing) return { accepted: true, reason: null }
  if (existing.conflict) {
    return {
      accepted: false,
      reason: existing.conflictReason ?? 'binding is already conflicted',
    }
  }
  if (
    existing.programId.toLowerCase() !== incoming.programId.toLowerCase() ||
    existing.outputDomain?.toLowerCase() !==
      incoming.outputDomain.toLowerCase() ||
    existing.instanceId.toLowerCase() !== incoming.instanceId.toLowerCase()
  ) {
    return {
      accepted: false,
      reason:
        `snapshot ${incoming.snapshot} was already bound to instance ${existing.instanceId}, ` +
        `program ${existing.programId}, domain ${existing.outputDomain}`,
    }
  }
  return { accepted: true, reason: null }
}

/** Pure continuity rule for the registry's restricted params-hash rotation event. */
export const decideParamsHashRotation = (
  existing: ScoreBindingIdentity,
  oldParamsHash: string
): ScoreBindingDecision => {
  if (existing.conflict) {
    return {
      accepted: false,
      reason: existing.conflictReason ?? 'binding is already conflicted',
    }
  }
  if (existing.paramsHash.toLowerCase() !== oldParamsHash.toLowerCase()) {
    return {
      accepted: false,
      reason:
        `params history mismatch for ${existing.instanceId}: binding has ${existing.paramsHash}, ` +
        `event expected ${oldParamsHash}`,
    }
  }
  return { accepted: true, reason: null }
}
