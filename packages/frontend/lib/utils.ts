import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { formatUnits } from 'viem'

export const cn = (...inputs: ClassValue[]) => {
  return twMerge(clsx(inputs))
}

export const formatPercentage = (num: number) => {
  return (
    num.toLocaleString(undefined, {
      maximumSignificantDigits: 4,
    }) + '%'
  )
}

export const formatBigNumber = (
  num: bigint | number | string,
  /**
   * If decimals are passed, the number must be an integer.
   */
  decimals?: number,
  showFull?: boolean
): string => {
  const maxDigits = showFull ? (decimals ?? 18) : 3
  num = Number(decimals ? formatUnits(BigInt(num), decimals) : num)

  if (showFull) {
    return num.toLocaleString(undefined, {
      notation: 'standard',
      maximumFractionDigits: maxDigits,
    })
  }

  if (num >= 1e9) {
    return `${(num / 1e9).toLocaleString(undefined, {
      notation: 'standard',
      maximumFractionDigits: maxDigits,
    })}B`
  }
  if (num >= 1e6) {
    return `${(num / 1e6).toLocaleString(undefined, {
      notation: 'standard',
      maximumFractionDigits: maxDigits,
    })}M`
  }
  if (num >= 1e3) {
    return `${(num / 1e3).toLocaleString(undefined, {
      notation: 'standard',
      maximumFractionDigits: maxDigits,
    })}K`
  }
  if (num < 1) {
    return num.toLocaleString(undefined, {
      notation: 'standard',
      maximumSignificantDigits: maxDigits,
    })
  }
  return num.toLocaleString(undefined, {
    notation: 'standard',
    maximumFractionDigits: maxDigits,
  })
}

export const formatTimeAgo = (timestampOrMs: Date | number) => {
  if (timestampOrMs instanceof Date) {
    timestampOrMs = timestampOrMs.getTime()
  }

  const now = Date.now()
  const diffInSeconds = Math.abs(Math.floor((now - timestampOrMs) / 1000))
  const suffix = timestampOrMs < now ? 'ago' : 'remaining'

  if (diffInSeconds < 60) {
    return `<1m ${suffix}`
  } else if (diffInSeconds < 3600) {
    return `${Math.floor(diffInSeconds / 60)}m ${suffix}`
  } else if (diffInSeconds < 86400) {
    return `${Math.floor(diffInSeconds / 3600)}h ${suffix}`
  } else {
    return `${Math.floor(diffInSeconds / 86400)}d ${suffix}`
  }
}

/**
 * Check if two hex values are equal.
 *
 * @param hex1 - The first hex value.
 * @param hex2 - The second hex value.
 * @returns True if the hex values are equal, false otherwise.
 */
export const isHexEqual = (hex1: string, hex2: string) =>
  hex1.toLowerCase() === hex2.toLowerCase()

/**
 * An address a query can actually be run against, or `undefined`.
 *
 * A network created through the factory without a Safe, distributor or gov module still carries
 * those fields — set to the ZERO address, which is a truthy string. So `enabled: !!addr` lets the
 * query run, it matches no row, and the page shows an error where it should show nothing. Use this
 * for any contract a network is allowed not to have.
 */
export const realAddress = (addr?: string | null): `0x${string}` | undefined =>
  addr && addr !== '0x0000000000000000000000000000000000000000'
    ? (addr as `0x${string}`)
    : undefined
