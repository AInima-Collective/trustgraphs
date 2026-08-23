//! The 21-word `paramsHash` encoding (INTERFACES.md §3) — frozen, golden-locked against
//! `contributions_core::params::params_hash` and `ContributionsParamsCodec.sol` via
//! `tests/golden/contributions.json`. All static ABI types, so the encoding is the
//! concatenation of 32-byte words.

import { type Hex, concat, keccak256 } from 'viem'

import { type ContributionsParams } from './types'
import { seedSetRoot } from '../pagerank/merkle'
import { cmpHex, wordU256, wordU32, wordU64 } from '../pagerank/words'

export const PARAMS_SCHEMA_VERSION = 3

/**
 * The `seedSetRoot` folded into slot 9: an OZ StandardMerkleTree over the *sorted* trusted-seed
 * set, leaf = `keccak256(abi.encode(address))` — same builder as the trust program. The struct
 * carries the raw (unsorted) seed list; sorting here makes the hash depend only on the seed set.
 */
export const contributionsSeedSetRoot = (seeds: Hex[]): Hex => {
  const sorted = [...seeds].sort(cmpHex)
  return seedSetRoot(sorted)
}

/**
 * The governance-pinned `paramsHash`: keccak over the concatenation of the 21 static ABI words
 * (INTERFACES.md §3 slot order). Bound the same way every program binds params: the contrib
 * `MerkleSnapshot.submitProof` builds the journal digest from its stored `paramsHash`, so a
 * proof under different params yields a different digest and fails verification.
 */
export const paramsHash = (p: ContributionsParams): Hex =>
  keccak256(
    concat([
      wordU32(PARAMS_SCHEMA_VERSION),
      wordU256(p.dampingFp),
      wordU256(p.toleranceFp),
      wordU32(p.maxIterations),
      wordU256(p.minWeightFp),
      wordU256(p.maxWeightFp),
      wordU256(p.trustShareFp),
      wordU256(p.trustDecayFp),
      contributionsSeedSetRoot(p.trustedSeeds),
      wordU256(p.precisionScale),
      wordU32(p.weightFieldIndex),
      wordU64(p.roundStart),
      wordU64(p.roundEnd),
      wordU256(p.unacceptedMultFp),
      wordU256(p.collaboratorMultFp),
      wordU256(p.minRaterRepFp),
      wordU32(p.evaluatorCarveoutBps),
      wordU256(p.totalPool),
      p.claimSchemaUid,
      p.responseSchemaUid,
      p.valuationSchemaUid,
    ])
  )
