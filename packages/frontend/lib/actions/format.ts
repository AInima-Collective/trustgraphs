import { formatEther, formatUnits } from 'viem'

import { formatApproxDuration } from '../duration'

/** Symbol and decimals verified for one token, used to render base units for people. */
export type TokenDisplay = { decimals: number; symbol: string }

/** `1e18` scales fee and quorum fractions on-chain: `formatUnits(x, 16)` yields a percentage. */
export const PERCENT_SCALE_DECIMALS = 16
/** ProvingVault denominates USD caps in `1e8` (`ProvingVault.USD`). */
export const USD_DECIMALS = 8
/** Basis points: 10000 = 100%. */
export const BPS_DECIMALS = 2

const DIGITS = /^\d+$/

const parseUnsigned = (value: string): bigint | null =>
  DIGITS.test(value) ? BigInt(value) : null

const groupDigits = (integer: string) =>
  integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** Group the integer part of a decimal string and drop trailing fraction zeros. */
export const formatDecimalString = (value: string): string => {
  const negative = value.startsWith('-')
  const [integer = '0', fraction = ''] = (
    negative ? value.slice(1) : value
  ).split('.')
  const trimmed = fraction.replace(/0+$/, '')
  return `${negative ? '-' : ''}${groupDigits(integer)}${trimmed ? `.${trimmed}` : ''}`
}

/** "1,234.5 USDC" when the token is known; otherwise the exact base units, labelled as such. */
export const formatTokenAmount = (
  baseUnits: string,
  token?: TokenDisplay | null
): string => {
  const parsed = parseUnsigned(baseUnits)
  if (parsed === null) return baseUnits
  if (!token) return `${groupDigits(baseUnits)} base units`
  return `${formatDecimalString(formatUnits(parsed, token.decimals))} ${token.symbol}`
}

/** "1.25 ETH" from a wei string. */
export const formatWei = (wei: string): string => {
  const parsed = parseUnsigned(wei)
  return parsed === null
    ? wei
    : `${formatDecimalString(formatEther(parsed))} ETH`
}

/** "2.5%" from a `1e18`-scaled fraction. */
export const formatPercent18 = (fraction: string): string => {
  const parsed = parseUnsigned(fraction)
  return parsed === null
    ? fraction
    : `${formatDecimalString(formatUnits(parsed, PERCENT_SCALE_DECIMALS))}%`
}

/** "15%" from basis points. */
export const formatBps = (bps: string): string => {
  const parsed = parseUnsigned(bps)
  return parsed === null
    ? bps
    : `${formatDecimalString(formatUnits(parsed, BPS_DECIMALS))}%`
}

/** "$250.00" from a `1e8`-scaled USD amount. */
export const formatUsd8 = (usd: string): string => {
  const parsed = parseUnsigned(usd)
  if (parsed === null) return usd
  const [integer = '0', fraction = ''] = formatUnits(
    parsed,
    USD_DECIMALS
  ).split('.')
  const cents = fraction.replace(/0+$/, '')
  const shown = cents.length <= 2 ? cents.padEnd(2, '0') : cents
  return `$${groupDigits(integer)}.${shown}`
}

const pad = (value: number) => String(value).padStart(2, '0')

/** "2026-09-30 14:00 UTC": one unambiguous rendering for proposers and reviewers alike. */
export const formatUtcDateTime = (seconds: number): string => {
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}

/** "in ~23 days" or "~3 hours ago" relative to `now` (unix seconds). */
export const formatRelativeSeconds = (
  seconds: number,
  now: number = Math.floor(Date.now() / 1000)
): string => {
  const delta = seconds - now
  const duration = formatApproxDuration(delta)
  if (duration === 'moments')
    return delta >= 0 ? 'moments from now' : 'just now'
  return delta >= 0 ? `in ${duration}` : `${duration} ago`
}

/**
 * A unix-seconds string for people: absolute UTC plus a relative hint. A zero value renders the
 * caller's label when the contract treats zero specially ("No expiry").
 */
export const formatUnixSeconds = (
  seconds: string,
  options: { zeroLabel?: string; now?: number } = {}
): string => {
  const parsed = parseUnsigned(seconds)
  if (parsed === null) return seconds
  if (parsed === 0n && options.zeroLabel) return options.zeroLabel
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) return seconds
  const value = Number(parsed)
  const absolute = formatUtcDateTime(value)
  return absolute
    ? `${absolute} (${formatRelativeSeconds(value, options.now)})`
    : seconds
}

/** "14,400 blocks (~2 days)" given the chain's block time. */
export const formatBlockCount = (
  blocks: string,
  blockTimeSeconds = 12
): string => {
  const parsed = parseUnsigned(blocks)
  if (parsed === null) return blocks
  const label = `${groupDigits(blocks)} ${parsed === 1n ? 'block' : 'blocks'}`
  if (parsed === 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) return label
  return `${label} (${formatApproxDuration(Number(parsed) * blockTimeSeconds)})`
}

/** Whole blocks covering `seconds`, rounded up so a chosen duration is never cut short. */
export const blocksForSeconds = (
  seconds: number,
  blockTimeSeconds = 12
): bigint => {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0n
  return BigInt(Math.ceil(seconds / blockTimeSeconds))
}

/** "0x1234…abcd" for hashes and addresses in prose. */
export const shortenHex = (value: string, visible = 6): string =>
  value.length > visible * 2 + 2
    ? `${value.slice(0, visible + 2)}…${value.slice(-visible)}`
    : value
