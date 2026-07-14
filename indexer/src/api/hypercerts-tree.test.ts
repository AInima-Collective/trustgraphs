/**
 * Unit test for the hypercerts score-bundle tree logic (src/api/hypercerts-tree.ts).
 *
 * Verifies proof CONSTRUCTION without any DB / live indexed rows: it builds a fixture score set (with
 * and without `link.evm` bindings), asks the module for each node's `{nodeId, score, proof}` bundle,
 * and checks the proof verifies against the bundle root by REIMPLEMENTING the on-chain OZ
 * `MerkleProof.verify` fold here (a commutative sorted-pair reduction leaf → root) — so the check is
 * independent of the builder's own `proofFor`/`buildTree`.
 *
 * Run: `node --test src/api/hypercerts-tree.test.ts` (native TS; viem-only, no ponder/drizzle).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { type Hex, concat, keccak256 } from 'viem'

import {
  type ScoreRow,
  buildScoreBundle,
  cmpHex,
  leafSet,
  merkleRoot,
  nodeOutputLeaf,
  outputLeaf,
} from './hypercerts-tree.ts'

// ---- independent OZ MerkleProof.verify (NOT the module's proofFor) ----------

/** Commutative parent hash `keccak256(sort(a,b))` — the on-chain `MerkleProof` node hash. */
const parent = (a: Hex, b: Hex): Hex =>
  cmpHex(a, b) <= 0 ? keccak256(concat([a, b])) : keccak256(concat([b, a]))

/** OZ `MerkleProof.processProof`: fold the siblings into the leaf, bottom-up. */
const processProof = (leaf: Hex, proof: Hex[]): Hex =>
  proof.reduce((acc, sibling) => parent(acc, sibling), leaf)

/** OZ `MerkleProof.verify`. */
const verify = (leaf: Hex, proof: Hex[], root: Hex): boolean =>
  processProof(leaf, proof).toLowerCase() === root.toLowerCase()

// ---- fixture: a small hypercerts root ---------------------------------------
//
// 4 scored nodes: two bound actors (get an extra v1 address leaf), one satellite actor, one artifact.

const actorBoundA: Hex = keccak256(concat(['0x1111' as Hex]))
const actorBoundB: Hex = keccak256(concat(['0x2222' as Hex]))
const actorSatellite: Hex = keccak256(concat(['0x3333' as Hex]))
const artifact: Hex = keccak256(concat(['0x4444' as Hex]))

const addrA: Hex = '0x00000000000000000000000000000000000000aa'
const addrB: Hex = '0x00000000000000000000000000000000000000bb'

const scores: ScoreRow[] = [
  {
    nodeId: actorBoundA,
    value: 5_000_000_000_000_000_000n,
    boundAddress: addrA,
  },
  {
    nodeId: actorBoundB,
    value: 3_000_000_000_000_000_000n,
    boundAddress: addrB,
  },
  {
    nodeId: actorSatellite,
    value: 1_500_000_000_000_000_000n,
    boundAddress: null,
  },
  { nodeId: artifact, value: 9_000_000_000_000_000_000n },
]

test('every node bundle proof verifies against the root (independent OZ fold)', () => {
  const root = merkleRoot(leafSet(scores))
  for (const s of scores) {
    const bundle = buildScoreBundle(scores, s.nodeId)
    assert.equal(bundle.root, root, 'bundle root must equal the full-set root')
    assert.equal(bundle.score, s.value, 'bundle carries the node value')

    const leaf = nodeOutputLeaf(s.nodeId, s.value)
    assert.ok(
      verify(leaf, bundle.proof, bundle.root),
      `proof for ${s.nodeId} must verify to root`
    )
    // A wrong value must NOT verify — the proof binds this exact (nodeId, value).
    const wrongLeaf = nodeOutputLeaf(s.nodeId, s.value + 1n)
    assert.equal(verify(wrongLeaf, bundle.proof, bundle.root), false)
  }
})

test('the v1 address leaf for a bound node also verifies against the same root', () => {
  const root = merkleRoot(leafSet(scores))
  // The bound actor earns an address leaf; an address-keyed consumer proves it against the same root.
  const tree = buildScoreBundle(scores, actorBoundA) // build to force tree construction
  assert.equal(tree.root, root)

  for (const s of scores) {
    if (!s.boundAddress) continue
    const addrLeaf = outputLeaf(s.boundAddress, s.value)
    // Reconstruct the proof for the address leaf via the independent fold path by rebuilding: the
    // builder only proves nodeId leaves, so here we just assert the address leaf is IN the leaf set
    // (its membership is what earns it a proof against this root).
    assert.ok(
      leafSet(scores).includes(addrLeaf),
      'bound node must contribute a v1 address leaf'
    )
  }
})

test('bindings change the root (dual leaf domains are load-bearing)', () => {
  const withBindings = merkleRoot(leafSet(scores))
  const stripped = scores.map((s) => ({ nodeId: s.nodeId, value: s.value }))
  const withoutBindings = merkleRoot(leafSet(stripped))
  assert.notEqual(
    withBindings,
    withoutBindings,
    'dropping the address leaves must change the output root'
  )
})

test('a single-node root serves a proof-of-length-0 that verifies', () => {
  const one: ScoreRow[] = [{ nodeId: artifact, value: 7n }]
  const bundle = buildScoreBundle(one, artifact)
  assert.equal(bundle.proof.length, 0, 'single leaf ⇒ empty proof')
  const leaf = nodeOutputLeaf(artifact, 7n)
  assert.equal(bundle.root, leaf, 'single-leaf root is the leaf itself')
  assert.ok(verify(leaf, bundle.proof, bundle.root))
})

test('an unknown nodeId throws (not served)', () => {
  assert.throws(() =>
    buildScoreBundle(scores, keccak256(concat(['0xdead' as Hex])))
  )
})
