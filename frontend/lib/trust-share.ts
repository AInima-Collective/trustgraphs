/** A full seed share leaves no baseline teleport mass for disconnected accounts. */
export const FULL_SEED_TRUST_SHARE_PCT = 100

/** Whether non-seed accounts divide a baseline before any vouches are applied. */
export const hasUnreservedTrustShare = (seedSharePct: number): boolean =>
  seedSharePct < FULL_SEED_TRUST_SHARE_PCT

export const unreservedTrustSharePct = (seedSharePct: number): number =>
  Math.max(0, FULL_SEED_TRUST_SHARE_PCT - seedSharePct)
