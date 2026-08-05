//! OpenZeppelin Standard Merkle Tree, reproduced exactly so browser-recomputed roots/proofs match
//! the zk guest and the on-chain `MerkleProof.verifyCalldata` (commutative / sorted-pair hashing).
//! Mirrors `pagerank_core::merkle`.

import { type Hex, concat, keccak256 } from 'viem'

import { ZERO_HASH, cmpHex, wordAddr, wordU256 } from './words'

/**
 * The output-tree leaf:
 * `keccak256(bytes.concat(keccak256(abi.encode(address account, uint256 value))))`.
 * Matches `MerkleSnapshot.sol` and the on-chain proof check.
 */
export const outputLeaf = (account: Hex, value: bigint): Hex => {
  const inner = keccak256(concat([wordAddr(account), wordU256(value)]))
  return keccak256(inner)
}

/** Commutative parent hash: `keccak256(sort(a, b))`. */
export const hashPair = (a: Hex, b: Hex): Hex => {
  const [lo, hi] = cmpHex(a, b) <= 0 ? [a, b] : [b, a]
  return keccak256(concat([lo, hi]))
}

/**
 * Build the full OZ StandardMerkleTree array (`2n-1` nodes). Leaves are sorted ascending and placed
 * at the tail in reverse order; internal node `i = hashPair(tree[2i+1], tree[2i+2])`; root = tree[0].
 */
export const buildTree = (leaves: Hex[]): Hex[] => {
  if (leaves.length === 0) return []
  const sorted = [...leaves].sort(cmpHex)
  const n = sorted.length
  if (n === 1) return sorted
  const size = 2 * n - 1
  const tree: Hex[] = new Array(size).fill(ZERO_HASH)
  for (let i = 0; i < n; i++) {
    tree[size - 1 - i] = sorted[i]
  }
  for (let i = n - 2; i >= 0; i--) {
    tree[i] = hashPair(tree[2 * i + 1], tree[2 * i + 2])
  }
  return tree
}

/** The OZ StandardMerkleTree root. Empty ⇒ `bytes32(0)`; single leaf ⇒ that leaf. */
export const merkleRoot = (leaves: Hex[]): Hex => {
  if (leaves.length === 0) return ZERO_HASH
  const tree = buildTree(leaves)
  return tree[0]
}

/** A Merkle proof (sibling hashes leaf→root, OZ format) for a leaf in a built tree. */
export const proofFor = (tree: Hex[], leaf: Hex): Hex[] | null => {
  if (tree.length === 0) return null
  const n = (tree.length + 1) / 2
  let idx = -1
  // Strict equality: all leaves/nodes are canonical lowercase hex from keccak256, matching the
  // Rust `merkle::proof_for`. A case-insensitive compare here would only mask an upstream bug.
  for (let i = n - 1; i < tree.length; i++) {
    if (tree[i] === leaf) {
      idx = i
      break
    }
  }
  if (idx < 0) return null
  const proof: Hex[] = []
  let i = idx
  while (i > 0) {
    const sibling = i % 2 === 1 ? i + 1 : i - 1
    if (sibling < tree.length) {
      proof.push(tree[sibling])
    }
    i = Math.floor((i - 1) / 2)
  }
  return proof
}

/**
 * The `seedSetRoot` folded into `paramsHash`: an OZ StandardMerkleTree over the sorted seed set,
 * with leaf = `keccak256(abi.encode(address seed))`. Empty set ⇒ `bytes32(0)`.
 */
export const seedSetRoot = (sortedSeeds: Hex[]): Hex => {
  if (sortedSeeds.length === 0) return ZERO_HASH
  const leaves = sortedSeeds.map((a) => keccak256(wordAddr(a)))
  return merkleRoot(leaves)
}

/**
 * The `signerSetRoot`: an OZ StandardMerkleTree over the sorted signer set (leaf =
 * `keccak256(abi.encode(address))`) — byte-identical to `seedSetRoot`. Mirrors
 * `pagerank_core::signer::signer_set_root`.
 */
export const signerSetRoot = (sortedSigners: Hex[]): Hex =>
  seedSetRoot(sortedSigners)
