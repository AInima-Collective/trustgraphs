import type { Hex } from 'viem'

import { fail } from './errors.ts'

export const ZERO32 = `0x${'00'.repeat(32)}` as Hex

export const hexToBytes = (value: Hex): Uint8Array => {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value))
    return fail('E0_CANONICAL', 'invalid even-length hex')
  const out = new Uint8Array((value.length - 2) / 2)
  for (let i = 0; i < out.length; i += 1)
    out[i] = Number.parseInt(value.slice(2 + i * 2, 4 + i * 2), 16)
  return out
}

export const bytesToHex = (value: Uint8Array): Hex =>
  `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')}`

export const concatBytes = (...values: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(
    values.reduce((sum, value) => sum + value.length, 0)
  )
  let offset = 0
  for (const value of values) {
    out.set(value, offset)
    offset += value.length
  }
  return out
}

export const uintBe = (value: bigint | number, width: number): Uint8Array => {
  let remaining = BigInt(value)
  if (remaining < 0n) return fail('E0_CANONICAL', 'negative unsigned integer')
  const out = new Uint8Array(width)
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  if (remaining !== 0n)
    return fail('E0_CANONICAL', `integer does not fit in ${width} bytes`)
  return out
}

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i += 1) difference |= a[i]! ^ b[i]!
  return difference === 0
}

export const utf8 = (value: string): Uint8Array =>
  new TextEncoder().encode(value)

export const base64Encode = (value: Uint8Array): string => {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export const base64Decode = (value: string): Uint8Array => {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}
