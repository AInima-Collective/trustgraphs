export const VERSION_STATUSES = [
  'pending',
  'active',
  'superseded',
  'cancelled',
  'inconsistent',
] as const

export const AVAILABILITY_STATUSES = [
  'available',
  'degraded',
  'unavailable',
] as const

export const boundedInteger = (
  raw: string | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER
) => {
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null
  return Math.min(parsed, maximum)
}

export const versionStatus = (value: string | undefined) =>
  value === undefined || VERSION_STATUSES.some((status) => status === value)

export const availabilityStatus = (value: string | undefined) =>
  value === undefined ||
  AVAILABILITY_STATUSES.some((status) => status === value)

export const serializeNormalizedEntries = (
  rows: Array<{
    position: number
    account: string
    normalizedWeight: bigint
  }>
) =>
  rows.map((entry) => ({
    position: entry.position,
    account: entry.account,
    normalizedWeight: entry.normalizedWeight.toString(),
  }))

export const availabilityView = (row: {
  availability: string
  provenance: string
  sourceTxHash: string
  availabilityError: string | null
  verifiedAt: bigint | null
}) => ({
  status: row.availability,
  provenance: row.provenance,
  sourceTxHash: row.sourceTxHash,
  error: row.availabilityError,
  verifiedAt: row.verifiedAt?.toString() ?? null,
})
