import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

const catalog = source('app/graph-lineages/catalog.tsx')
const detail = source('app/graph-lineages/[lineageId]/view.tsx')
const api = source('lib/graph-lineage.ts')
const config = source('lib/config.ts')

assert.match(catalog, /A Merkle root\s*\n?\s*is one epoch—not an actor/)
assert.match(detail, /Integrity, methodology, agreement, and warning claims/)
assert.match(detail, /Only active referral records/)
assert.match(detail, /mutable evidence/)
assert.match(detail, /shared \{overlap\}/)
assert.match(detail, /never change an account score/)
assert.match(catalog, /no graph-lineage registry configured/)
assert.match(
  catalog,
  /Existing\s*\n?\s*score, proof, and composition routes are unaffected/
)
assert.match(api, /GraphLineageApiUnavailableError/)
assert.match(config, /GRAPH_LINEAGE_CONFIG/)

console.log(
  'graph lineage actor/epoch separation, overlap, evidence, and advisory copy: ok'
)
