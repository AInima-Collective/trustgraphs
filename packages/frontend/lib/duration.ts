/**
 * "~2 days", "~3 hours", "~5 minutes", "moments". Coarse on purpose: block
 * math is an estimate and false precision reads as a promise.
 */
export const formatApproxDuration = (seconds: number): string => {
  const s = Math.abs(seconds)
  if (s < 90) return 'moments'
  if (s < 90 * 60) return `~${Math.round(s / 60)} minutes`
  if (s < 36 * 3600) return `~${Math.round(s / 3600)} hours`
  return `~${Math.round(s / 86400)} days`
}

/** Exact, human units for a duration the user typed: "2 days", "36 hours", "90 minutes". */
export const formatExactDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds % 86400 === 0) return plural(seconds / 86400, 'day')
  if (seconds % 3600 === 0) return plural(seconds / 3600, 'hour')
  if (seconds % 60 === 0) return plural(seconds / 60, 'minute')
  return plural(seconds, 'second')
}

const plural = (count: number, unit: string) =>
  `${count.toLocaleString('en-US')} ${unit}${count === 1 ? '' : 's'}`
