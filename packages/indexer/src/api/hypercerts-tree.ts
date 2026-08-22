/**
 * Hypercerts score-bundle tree logic — the exact OZ StandardMerkleTree the hypercerts guest emits,
 * ported to a self-contained viem-only module so the bundle API and its unit test can build/serve
 * `{nodeId, score, proof[]}` bundles that verify against the on-chain `outputRoot`.
 *
 * PROVENANCE (documented reuse). This is a byte-identical port of the two TS modules that are already
 * the canonical browser mirror of the guest tree:
 *   - `packages/frontend/lib/pagerank/merkle.ts` — `hashPair` / `buildTree` / `proofFor` / `outputLeaf`
 *     (OpenZeppelin StandardMerkleTree: leaves sorted ascending, commutative sorted-pair parent hash,
 *     `2n-1` node array, root = tree[0]); matches `pagerank_core::merkle` and the on-chain
 *     `MerkleProof.verifyCalldata`.
 *   - `packages/frontend/lib/hypercerts/recompute.ts` — `nodeOutputLeaf` (the unified nodeId leaf) mirroring
 *     `hypercerts_core::compute::node_output_leaf`.
 * It is re-implemented here (rather than imported) for two reasons: (1) the indexer typecheck runs
 * under `noUncheckedIndexedAccess`, which the frontend lib is not written against (importing it adds
 * pre-existing cross-package strictness errors), and (2) keeping the module viem-only lets the unit
 * test run under `node --test` with no ponder/drizzle/bundler in the loop.
 *
 * The leaf SET is the guest's (compute.rs step 5): a unified `keccak(nodeId, value)` leaf for EVERY
 * scored node, PLUS a v1 `keccak(address, value)` leaf for each node that carries a verified
 * `link.evm` binding — so address-keyed consumers verify against the same root unchanged.
 */
import { type Hex, concat, keccak256, pad, toHex } from 'viem'

// ---- ABI-word + comparison primitives (ported from pagerank/words.ts) -------

/** The 32-byte zero word / zero hash. */
export const ZERO_HASH: Hex = `0x${'00'.repeat(32)}`

/** A 32-byte ABI word from a `bigint` (uint256). */
export const wordU256 = (x: bigint): Hex => toHex(x, { size: 32 })

/** A 32-byte ABI word from an address (right-aligned 20 bytes). */
export const wordAddr = (a: Hex): Hex =>
  pad(a.toLowerCase() as Hex, { size: 32 })

/**
 * Compare two equal-length lowercase hex strings (nodeId / leaf hash) as big-endian byte strings.
 * Fixed length ⇒ lexicographic string order equals byte order.
 */
export const cmpHex = (a: Hex, b: Hex): number => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

// ---- leaf domains -----------------------------------------------------------

/**
 * The v1 address output leaf:
 * `keccak256(bytes.concat(keccak256(abi.encode(address account, uint256 value))))`.
 * Mirrors `merkle::output_leaf` / `MerkleSnapshot.sol`.
 */
export const outputLeaf = (account: Hex, value: bigint): Hex =>
  keccak256(keccak256(concat([wordAddr(account), wordU256(value)])))

/**
 * The unified nodeId output leaf:
 * `keccak256(bytes.concat(keccak256(abi.encode(bytes32 nodeId, uint256 value))))`.
 * Mirrors `hypercerts_core::compute::node_output_leaf`.
 */
export const nodeOutputLeaf = (nodeId: Hex, value: bigint): Hex =>
  keccak256(keccak256(concat([nodeId, wordU256(value)])))

// ---- OZ StandardMerkleTree (ported from pagerank/merkle.ts) -----------------

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
  const tree: Hex[] = new Array<Hex>(size).fill(ZERO_HASH)
  for (let i = 0; i < n; i++) {
    tree[size - 1 - i] = sorted[i] as Hex
  }
  for (let i = n - 2; i >= 0; i--) {
    tree[i] = hashPair(tree[2 * i + 1] as Hex, tree[2 * i + 2] as Hex)
  }
  return tree
}

/** The OZ StandardMerkleTree root. Empty ⇒ `bytes32(0)`; single leaf ⇒ that leaf. */
export const merkleRoot = (leaves: Hex[]): Hex => {
  if (leaves.length === 0) return ZERO_HASH
  const tree = buildTree(leaves)
  return tree[0] as Hex
}

/** A Merkle proof (sibling hashes leaf→root, OZ format) for a leaf in a built tree, or null. */
export const proofFor = (tree: Hex[], leaf: Hex): Hex[] | null => {
  if (tree.length === 0) return null
  const n = (tree.length + 1) / 2
  let idx = -1
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
      proof.push(tree[sibling] as Hex)
    }
    i = Math.floor((i - 1) / 2)
  }
  return proof
}

// ---- the score bundle -------------------------------------------------------

/**
 * One scored node for a given root: its nodeId, its distributed value, and (if bound via `link.evm`)
 * the EVM address that earns the extra v1 address leaf. Exactly the columns the hypercerts score table
 * stores for a root.
 */
export interface ScoreRow {
  nodeId: Hex
  value: bigint
  /** The verified `link.evm` binding, if any — drives the extra v1 address leaf. */
  boundAddress?: Hex | null
}

/** A served score bundle: ranking value + the OZ proof that verifies it against `root`. */
export interface ScoreBundle {
  nodeId: Hex
  score: bigint
  proof: Hex[]
  /** The OZ root recomputed from the full leaf set (must equal the on-chain `outputRoot`). */
  root: Hex
}

/**
 * The guest's full output-tree leaf set for a root: a unified nodeId leaf for every scored node, PLUS
 * a v1 address leaf for each bound node. Order is irrelevant (the tree sorts), but nodeId-sorting the
 * scores first mirrors the guest for readability.
 */
export const leafSet = (scores: ScoreRow[]): Hex[] => {
  const sorted = [...scores].sort((a, b) => cmpHex(a.nodeId, b.nodeId))
  const leaves: Hex[] = sorted.map((s) => nodeOutputLeaf(s.nodeId, s.value))
  for (const s of sorted) {
    if (s.boundAddress) leaves.push(outputLeaf(s.boundAddress, s.value))
  }
  return leaves
}

/**
 * Build the `{nodeId, score, proof, root}` bundle for `targetNodeId` from the full score set of a
 * root. Rebuilds the guest's exact tree, returns the OZ proof of the target's unified nodeId leaf, and
 * the recomputed root. The caller should assert `root` equals the on-chain `outputRoot` before serving
 * (a mismatch means the pinned score set does not reproduce the proven root — proofs would be useless).
 *
 * @throws if `targetNodeId` is not in `scores`.
 */
export const buildScoreBundle = (
  scores: ScoreRow[],
  targetNodeId: Hex
): ScoreBundle => {
  const key = targetNodeId.toLowerCase()
  const target = scores.find((s) => s.nodeId.toLowerCase() === key)
  if (!target) {
    throw new Error(
      `nodeId ${targetNodeId} not present in the root's score set`
    )
  }
  const tree = buildTree(leafSet(scores))
  const leaf = nodeOutputLeaf(target.nodeId, target.value)
  const proof = proofFor(tree, leaf)
  if (proof === null) {
    throw new Error(
      `could not locate the leaf for nodeId ${targetNodeId} in the tree`
    )
  }
  return {
    nodeId: target.nodeId,
    score: target.value,
    proof,
    root: merkleRoot(leafSet(scores)),
  }
}
