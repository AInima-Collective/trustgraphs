#!/usr/bin/env node
// Compute the canonical output-tree root for a trust-graph score blob, using the SAME merkle
// implementation the indexer's ingestion verifies against (packages/frontend/lib/pagerank/merkle).
// Used by tests/e2e/governed-creation.sh to submit a root whose blob the indexer can reproduce.
//
// Usage: node --import tsx tests/e2e/compute-dev-root.mjs <blob.json>
// Prints: {"root":"0x…","totalValue":"…"}
import { readFileSync } from 'node:fs'

import * as merkleModule from '../../packages/frontend/lib/pagerank/merkle.ts'

// The frontend package boundary is CommonJS under tsx, so named exports may sit under `default`
// (same normalization as packages/indexer/src/merkle-ingest.ts).
const merkle = 'default' in merkleModule ? merkleModule.default : merkleModule

const blobPath = process.argv[2]
if (!blobPath) {
  console.error('usage: node --import tsx tests/e2e/compute-dev-root.mjs <blob.json>')
  process.exit(1)
}

const scores = JSON.parse(readFileSync(blobPath, 'utf8'))
const leaves = Object.entries(scores).map(([account, value]) =>
  merkle.outputLeaf(account, BigInt(value))
)
const tree = merkle.buildTree(leaves)
const totalValue = Object.values(scores).reduce(
  (sum, value) => sum + BigInt(value),
  0n
)

console.log(JSON.stringify({ root: tree[0], totalValue: totalValue.toString() }))
