//! Canonical IPFS blob + CIDv1 (raw codec, sha2-256). Mirrors `pagerank_core::cid`.
//!
//! The blob is a compact JSON object `{"0x<addr>":"<decimal value>",...}` with addresses lowercased
//! and sorted ascending. Its SHA2-256 digest is `ipfsHash`; the CIDv1-raw string is `ipfsHashCid`.

import { type Hex, bytesToHex, sha256 as viemSha256 } from 'viem'

/**
 * Serialize the scored set to the canonical blob. `scores` MUST be sorted ascending by address and
 * contain only `value > 0` entries.
 */
export const canonicalBlob = (scores: Array<[Hex, bigint]>): string => {
  let s = '{'
  for (let i = 0; i < scores.length; i++) {
    if (i > 0) s += ','
    const [addr, value] = scores[i]
    s += '"' + addr.toLowerCase() + '":"' + value.toString() + '"'
  }
  s += '}'
  return s
}

/** SHA2-256 digest of the UTF-8 bytes of a string, returned as a 32-byte Uint8Array. */
export const sha256Utf8 = (data: string): Uint8Array => {
  const bytes = new TextEncoder().encode(data)
  const hex = viemSha256(bytes)
  return hexBytes32(hex)
}

const hexBytes32 = (hex: Hex): Uint8Array => {
  const clean = hex.slice(2)
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/**
 * CIDv1, raw codec (0x55), sha2-256 multihash, multibase base32-lower ("b" prefix).
 * Bytes: `0x01 (cidv1) || 0x55 (raw) || 0x12 (sha2-256) || 0x20 (len 32) || digest`.
 */
export const cidV1Raw = (digest: Uint8Array): string => {
  const bytes = new Uint8Array(4 + 32)
  bytes.set([0x01, 0x55, 0x12, 0x20], 0)
  bytes.set(digest, 4)
  return 'b' + base32LowerNopad(bytes)
}

/** RFC 4648 base32, lowercase alphabet, no padding. */
const base32LowerNopad = (data: Uint8Array): string => {
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
  let out = ''
  // 32-bit accumulator (kept unsigned via `>>> 0`), mirroring the Rust `u32` implementation.
  let acc = 0
  let bits = 0
  for (const b of data) {
    acc = ((acc << 8) | b) >>> 0
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(acc >>> bits) & 0x1f]
    }
  }
  if (bits > 0) {
    out += ALPHABET[((acc << (5 - bits)) >>> 0) & 0x1f]
  }
  return out
}

/** The `ipfsHash` (sha256 digest) as a `0x`-hex string. */
export const digestToHex = (digest: Uint8Array): Hex => bytesToHex(digest)
