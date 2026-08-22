import { type Hex } from 'viem'

import * as merkleModule from '../../frontend/lib/pagerank/merkle'

// Ponder bundles the frontend TypeScript module as ESM, while the standalone node:test/tsx
// repair check crosses the frontend package boundary (whose package.json is CommonJS) and sees
// the same named exports under `default`. Normalize that loader distinction without creating a
// second Merkle implementation.
const merkle =
  'default' in merkleModule
    ? (
        merkleModule as typeof merkleModule & {
          default: typeof merkleModule
        }
      ).default
    : merkleModule

/** Canonical address-keyed score blob committed by the trust-graph guests. */
export type ScoreBlob = Record<string, string>

export type AddressMerkleRow = {
  account: string
  value: bigint
  proof: Hex[]
}

/**
 * The indexer's pure ingestion boundary: parse canonical score values, rebuild the exact output
 * tree, require the chain root, and derive every database row/proof. Keeping this free of Ponder
 * and Postgres makes the unavailable-CID repair path integration-testable while production calls
 * the same code immediately before its inserts.
 */
export const deriveAddressMerkleRows = (
  scores: ScoreBlob,
  expectedRoot: string
): { computedRoot: Hex | null; rows: AddressMerkleRow[] } => {
  const entries = Object.entries(scores)
  const leaves = entries.map(([account, value]) =>
    merkle.outputLeaf(account as Hex, BigInt(value))
  )
  const tree = merkle.buildTree(leaves)
  const computedRoot = tree[0] ?? null
  if (
    computedRoot !== null &&
    computedRoot.toLowerCase() !== expectedRoot.toLowerCase()
  ) {
    throw new Error(
      `recomputed root ${computedRoot} != on-chain root ${expectedRoot}`
    )
  }
  return {
    computedRoot,
    rows: entries.map(([account, value], index) => ({
      account,
      value: BigInt(value),
      proof: merkle.proofFor(tree, leaves[index]!) ?? [],
    })),
  }
}
