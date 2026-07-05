import { pad, toHex, type Hex } from 'viem'

/** The 32-byte zero word / zero hash. */
export const ZERO_HASH: Hex = `0x${'00'.repeat(32)}`

/** A 32-byte ABI word from a `bigint` (uint256). */
export const wordU256 = (x: bigint): Hex => toHex(x, { size: 32 })

/** A 32-byte ABI word from a `bigint` (uint64, left-padded like any uintN). */
export const wordU64 = (x: bigint): Hex => toHex(x, { size: 32 })

/** A 32-byte ABI word from a `number` (uint32). */
export const wordU32 = (x: number): Hex => toHex(BigInt(x), { size: 32 })

/** A 32-byte ABI word from a `number` (uint8). */
export const wordU8 = (x: number): Hex => toHex(BigInt(x), { size: 32 })

/** A 32-byte ABI word from an address (right-aligned 20 bytes). */
export const wordAddr = (a: Hex): Hex =>
  pad(a.toLowerCase() as Hex, { size: 32 })

/**
 * Compare two equal-length lowercase hex strings (B256 / address) as big-endian byte strings.
 * Because they are fixed length, lexicographic string order equals byte order.
 */
export const cmpHex = (a: Hex, b: Hex): number => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

/** Compare two bigints, returning -1/0/1 (for Array.sort comparators). */
export const cmpBig = (a: bigint, b: bigint): number =>
  a < b ? -1 : a > b ? 1 : 0
