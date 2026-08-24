import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { PROGRAM_ORDER, SECTION_META } from './directory'

assert.equal(SECTION_META['trust-graph'].scoredLabel, 'Scored accounts')
assert.ok(PROGRAM_ORDER.includes('nostr-workspace'))
assert.equal(SECTION_META['nostr-workspace'].scoredLabel, 'Members and agents')

// Weighted instances' persistent surface: discovery opens a network overview; rotation is a
// separate action from that page.
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
assert.doesNotMatch(server, /create\/weighted\?instance=\$\{source\.id\}/)
assert.match(server, /`\/networks\/\$\{source\.id\}`/)

console.log('directory denominator tests passed')
