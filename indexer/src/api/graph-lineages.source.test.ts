import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

test('graph lineage APIs are mounted, bounded, and canonically confirm active status', () => {
  const api = source('./graph-lineages.ts')
  const root = source('./index.ts')
  assert.match(root, /app\.route\('\/graph-lineages', graphLineages\)/)
  assert.match(api, /app\.post\('\/recommendations'/)
  assert.match(api, /blockTag: 'finalized'/)
  assert.match(api, /bodyLimit/)
  assert.match(api, /canonical unsigned integer strings/)
  assert.match(api, /RECOMMENDATION_API_MAX_ACTIVE_EDGES/)
  assert.match(api, /previousFinalizedEpochOnly: true/)
  assert.match(api, /graphReputationL1/)
  assert.match(api, /never writes a composition policy/)
  assert.doesNotMatch(api, /db\.(insert|update|delete)/)
  assert.match(api, /\.limit\(5_000\)/)
  assert.match(api, /functionName: 'endorsementStatus'/)
  assert.match(api, /functionName: 'configurationLive'/)
  assert.match(api, /return 'verification-unavailable'/)
  assert.match(api, /eq\(graphEndorsement\.kind, 2\)/)
  assert.match(api, /previousEpochOnly: true/)
  assert.match(api, /advisoryOnly: true/)
})

test('lineage indexing is an isolated advisory namespace with append-only history', () => {
  const handler = source('../graph-lineage.ts')
  const schema = source('../../ponder.schema.ts')
  assert.doesNotMatch(handler, /merkleEntry|merkleState|compositionAttribution/)
  assert.match(handler, /graphLineageConfiguration/)
  assert.match(handler, /supersededAtBlock/)
  assert.match(handler, /supersededBy/)
  assert.match(handler, /revocationRef/)
  assert.match(schema, /graph_lineage_epoch/)
  assert.match(schema, /evidenceMutable/)
})
