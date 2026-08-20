import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { PROGRAM_ORDER, SECTION_META } from './directory'

assert.equal(SECTION_META['trust-graph'].scoredLabel, 'Scored accounts')
assert.ok(PROGRAM_ORDER.includes('nostr-workspace'))
assert.equal(SECTION_META['nostr-workspace'].scoredLabel, 'Members and agents')

// Weighted instances' persistent surface (GOAL M2): a section fed by GET /weighted-priors whose
// rows link into the workspace's update view, where the full id is copyable.
assert.ok(PROGRAM_ORDER.includes('trust-graph-weighted'))
assert.equal(SECTION_META['trust-graph-weighted'].title, 'Weighted networks')

const server = readFileSync('lib/directory.server.ts', 'utf8')
assert.match(
  server,
  /score-programs\?program=nostr-workspace&limit=/,
  'Nostr workspaces must be discovered from the authenticated score-program catalog'
)
assert.match(server, /parseScoreProgramProvenance/)
assert.match(server, /nostr-workspaces\/\$\{source\.snapshot\}/)
assert.match(
  server,
  /weighted-priors\?limit=/,
  'Weighted networks must be discovered from the indexer weighted-prior list'
)
assert.match(server, /create\/weighted\?instance=\$\{source\.id\}/)

console.log('directory denominator tests passed')
