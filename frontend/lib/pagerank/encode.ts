//! Exact byte encodings shared with Solidity. Mirrors `pagerank_core::encode`. Every function here
//! reproduces `abi.encode` / `keccak256` for the frozen tuples (all STATIC ABI types, so `abi.encode`
//! is simply the concatenation of 32-byte big-endian words).

import { concat, hexToBytes, keccak256, type Hex } from 'viem'

import { seedSetRoot } from './merkle'
import { type Journal, type Params, type RawEdge } from './types'
import {
  wordAddr,
  wordU256,
  wordU32,
  wordU64,
  wordU8,
  ZERO_HASH,
} from './words'

/**
 * The accumulator edge leaf:
 * `keccak256(abi.encode(uint8 kind, address attester, address recipient, bytes32 uid,
 *                       uint256 blockTimestamp, bytes32 dataHash))`.
 */
export const edgeLeaf = (
  kind: number,
  attester: Hex,
  recipient: Hex,
  uid: Hex,
  blockTimestamp: bigint,
  dataHash: Hex
): Hex =>
  keccak256(
    concat([
      wordU8(kind),
      wordAddr(attester),
      wordAddr(recipient),
      uid,
      wordU256(blockTimestamp),
      dataHash,
    ])
  )

/** Fold a leaf into the running accumulator: `acc' = keccak256(abi.encode(bytes32 acc, bytes32 leaf))`. */
export const fold = (prev: Hex, leaf: Hex): Hex =>
  keccak256(concat([prev, leaf]))

/**
 * Recompute the running accumulator over the full edge set, returning `{ acc, leafCount }`.
 * `acc_0 = bytes32(0)`.
 */
export const accumulate = (edges: RawEdge[]): { acc: Hex; leafCount: bigint } => {
  let acc: Hex = ZERO_HASH
  for (const e of edges) {
    const dataHash = keccak256(e.data)
    const leaf = edgeLeaf(
      e.kind,
      e.attester,
      e.recipient,
      e.uid,
      e.blockTimestamp,
      dataHash
    )
    acc = fold(acc, leaf)
  }
  return { acc, leafCount: BigInt(edges.length) }
}

/**
 * The ABI-encoded journal tuple — the preimage of the journal digest:
 * `abi.encode(bytes32 acc, uint64 leafCount, bytes32 paramsHash, bytes32 outputRoot,
 *             bytes32 ipfsHash, bytes32 cidDigest, uint256 totalValue)`.
 */
export const journalEncoded = (j: Journal): Hex =>
  concat([
    j.acc,
    wordU64(j.leafCount),
    j.paramsHash,
    j.outputRoot,
    j.ipfsHash,
    j.cidDigest,
    wordU256(j.totalValue),
  ])

/** The journal digest = `keccak256(journalEncoded(j))`. This is what the on-chain verifier binds. */
export const journalDigest = (j: Journal): Hex => keccak256(journalEncoded(j))

/**
 * The governance-pinned `paramsHash` (PLAN.md §1.3). `seedSetRoot` is computed over the sorted
 * trusted-seed set.
 */
export const paramsHash = (p: Params): Hex => {
  const seeds = [...p.trustedSeeds].sort((a, b) =>
    a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0
  )
  const seedRoot = seedSetRoot(seeds)
  return keccak256(
    concat([
      wordU256(p.dampingFp),
      wordU256(p.toleranceFp),
      wordU32(p.maxIterations),
      wordU256(p.minWeightFp),
      wordU256(p.maxWeightFp),
      wordU256(p.trustMultiplierFp),
      wordU256(p.trustShareFp),
      wordU256(p.trustDecayFp),
      seedRoot,
      wordU256(p.totalPool),
      wordU256(p.precisionScale),
      p.schemaUid,
      wordU32(p.weightFieldIndex),
    ])
  )
}

/**
 * Decode the confidence (weight) uint256 from ABI-encoded attestation `data` at head slot `index`.
 * Returns `null` if the data is too short — mirroring the legacy "decode failed ⇒ weight 0".
 */
export const decodeWeight = (data: Hex, index: number): bigint | null => {
  const bytes = hexToBytes(data)
  const start = index * 32
  const end = start + 32
  if (bytes.length < end) return null
  let v = 0n
  for (let i = start; i < end; i++) {
    v = (v << 8n) | BigInt(bytes[i])
  }
  return v
}
