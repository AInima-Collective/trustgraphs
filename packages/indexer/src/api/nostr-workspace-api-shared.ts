export const DEFAULT_NOSTR_PAGE_LIMIT = 50
export const MAX_NOSTR_PAGE_LIMIT = 200

export type NostrPage = { limit: number; offset: number }

/** Parse bounded, offset-based API pagination without accepting floats, negatives, or overflow. */
export const nostrPage = (
  limitRaw: string | undefined,
  offsetRaw: string | undefined
): NostrPage | null => {
  const parse = (
    raw: string | undefined,
    fallback: number,
    maximum: number
  ) => {
    if (raw === undefined) return fallback
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) return null
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value > maximum) return null
    return value
  }
  const limit = parse(limitRaw, DEFAULT_NOSTR_PAGE_LIMIT, MAX_NOSTR_PAGE_LIMIT)
  const offset = parse(offsetRaw, 0, Number.MAX_SAFE_INTEGER)
  return limit === null || offset === null ? null : { limit, offset }
}
