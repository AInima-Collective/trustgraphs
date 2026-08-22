//! Contribution record payload decoding (INTERFACES.md §1). Mirrors
//! `contributions_core::records`.
//!
//! Every decoder is total and deterministic: a malformed payload yields `null` (a provable
//! in-guest skip), never a throw. Validation is STRUCTURAL — exact ABI shape, in-bounds
//! offsets, clean static words, frozen value domains — because deterministic skip rules are
//! the only shape enforcement the proven statement has (anyone can attest garbage bytes at a
//! registered schema).

import { type Hex, bytesToHex, hexToBytes } from 'viem'

/**
 * A decoded `contribution.claim` payload:
 * `abi.encode(string title, bytes32 contentHash, string uri, address[] contributors, uint32[] shares)`.
 *
 * Only `contributors`/`shares` are consumed (attribution) — `title`/`uri` are display data —
 * but the WHOLE payload must be structurally valid for the claim to count.
 */
export interface ClaimPayload {
  contentHash: Hex
  /** As attested, in order (duplicates allowed; reconciliation aggregates per address). */
  contributors: Hex[]
  shares: number[]
}

/** A decoded `contribution.response` payload: `abi.encode(bytes32 claimUID, uint8 response)`. */
export interface ResponsePayload {
  claimUid: Hex
  /** 1 = accept, 2 = reject (the only valid values; anything else is a skip). */
  response: number
}

/** A decoded `contribution.valuation` payload: `abi.encode(bytes32 claimUID, uint8 score)`. */
export interface ValuationPayload {
  claimUid: Hex
  /** score ∈ [0, 100] (frozen domain; anything else is a skip). */
  score: number
}

const U32_MAX = 0xffffffffn

/** Read the 32-byte word at `slot` (0-indexed), if in bounds. */
const word = (data: Uint8Array, slot: number): Uint8Array | null => {
  const start = slot * 32
  const end = start + 32
  if (data.length < end) return null
  return data.subarray(start, end)
}

/** Decode a clean `uint8` word (upper 31 bytes zero). */
const wordAsU8 = (w: Uint8Array): number | null => {
  for (let i = 0; i < 31; i++) if (w[i] !== 0) return null
  return w[31] ?? null
}

/** Decode a clean `uint32` word. */
const wordAsU32 = (w: Uint8Array): number | null => {
  for (let i = 0; i < 28; i++) if (w[i] !== 0) return null
  const a = w[28]
  const b = w[29]
  const c = w[30]
  const d = w[31]
  if (a === undefined || b === undefined || c === undefined || d === undefined)
    return null
  return a * 0x1000000 + b * 0x10000 + c * 0x100 + d
}

/** Decode a clean `address` word (upper 12 bytes zero). */
const wordAsAddress = (w: Uint8Array): Hex | null => {
  for (let i = 0; i < 12; i++) if (w[i] !== 0) return null
  return bytesToHex(w.subarray(12))
}

/**
 * Decode a usize-safe offset/length word. Values above `u32::MAX` are rejected (no real
 * payload is 4 GiB; rejects absurd offsets deterministically — mirrors `word_as_usize`).
 */
const wordAsUsize = (w: Uint8Array): number | null => {
  let v = 0n
  for (const b of w) v = (v << 8n) | BigInt(b)
  if (v > U32_MAX) return null
  return Number(v)
}

/**
 * Validate a dynamic `string`/`bytes` region at head-relative `offset`: the length word plus
 * `len` bytes must be in bounds. Content is not interpreted (display data).
 */
const checkDynamicBytes = (data: Uint8Array, offset: number): boolean => {
  if (offset % 32 !== 0) return false
  const lenWord = word(data, offset / 32)
  if (lenWord === null) return false
  const len = wordAsUsize(lenWord)
  if (len === null) return false
  return data.length >= offset + 32 + len
}

/** Decode `contribution.claim` data. `null` = malformed (deterministic skip). */
export const decodeClaim = (dataHex: Hex): ClaimPayload | null => {
  const data = hexToBytes(dataHex)
  // Head: [0] title offset, [1] contentHash, [2] uri offset, [3] contributors offset,
  //       [4] shares offset.
  const w0 = word(data, 0)
  if (w0 === null) return null
  const titleOff = wordAsUsize(w0)
  if (titleOff === null) return null
  const w1 = word(data, 1)
  if (w1 === null) return null
  const contentHash = bytesToHex(w1)
  const w2 = word(data, 2)
  if (w2 === null) return null
  const uriOff = wordAsUsize(w2)
  if (uriOff === null) return null
  const w3 = word(data, 3)
  if (w3 === null) return null
  const contributorsOff = wordAsUsize(w3)
  if (contributorsOff === null) return null
  const w4 = word(data, 4)
  if (w4 === null) return null
  const sharesOff = wordAsUsize(w4)
  if (sharesOff === null) return null

  if (!checkDynamicBytes(data, titleOff)) return null
  if (!checkDynamicBytes(data, uriOff)) return null

  // contributors: length word + n address words.
  if (contributorsOff % 32 !== 0 || sharesOff % 32 !== 0) return null
  const nWord = word(data, contributorsOff / 32)
  if (nWord === null) return null
  const n = wordAsUsize(nWord)
  if (n === null) return null
  const mWord = word(data, sharesOff / 32)
  if (mWord === null) return null
  const m = wordAsUsize(mWord)
  if (m === null) return null
  if (n !== m || n === 0) return null

  const contributors: Hex[] = []
  for (let i = 0; i < n; i++) {
    const aw = word(data, contributorsOff / 32 + 1 + i)
    if (aw === null) return null
    const a = wordAsAddress(aw)
    if (a === null) return null
    contributors.push(a)
  }
  const shares: number[] = []
  for (let i = 0; i < n; i++) {
    const sw = word(data, sharesOff / 32 + 1 + i)
    if (sw === null) return null
    const s = wordAsU32(sw)
    if (s === null) return null
    shares.push(s)
  }
  // A claim whose shares are all zero has no attribution to normalize — malformed.
  if (shares.every((s) => s === 0)) return null
  return { contentHash, contributors, shares }
}

/** Decode `contribution.response` data. `null` = malformed (deterministic skip). */
export const decodeResponse = (dataHex: Hex): ResponsePayload | null => {
  const data = hexToBytes(dataHex)
  const w0 = word(data, 0)
  if (w0 === null) return null
  const claimUid = bytesToHex(w0)
  const w1 = word(data, 1)
  if (w1 === null) return null
  const response = wordAsU8(w1)
  if (response === null) return null
  if (response !== 1 && response !== 2) return null
  return { claimUid, response }
}

/** Decode `contribution.valuation` data. `null` = malformed (deterministic skip). */
export const decodeValuation = (dataHex: Hex): ValuationPayload | null => {
  const data = hexToBytes(dataHex)
  const w0 = word(data, 0)
  if (w0 === null) return null
  const claimUid = bytesToHex(w0)
  const w1 = word(data, 1)
  if (w1 === null) return null
  const score = wordAsU8(w1)
  if (score === null) return null
  if (score > 100) return null
  return { claimUid, score }
}
