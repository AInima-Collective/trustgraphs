import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('Nostr workspace API is authenticated, paginated, and content-free', () => {
  const routes = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const scoreProgramSource = readFileSync(
    new URL('./score-programs.ts', import.meta.url),
    'utf8'
  )
  const source = readFileSync(
    new URL('./nostr-workspace.ts', import.meta.url),
    'utf8'
  )
  assert.match(routes, /app\.route\('\/nostr-workspace', nostrWorkspace\)/)
  assert.match(routes, /app\.route\('\/score-programs', scorePrograms\)/)
  assert.match(scoreProgramSource, /app\.get\('\/'/)
  assert.match(scoreProgramSource, /scoreProgramBinding\.programId/)
  assert.match(scoreProgramSource, /scoreProgramBinding\.outputDomain/)
  assert.match(scoreProgramSource, /scoreProgramBinding\.conflict, false/)
  assert.match(scoreProgramSource, /serializeScoreProgramBinding/)
  assert.match(source, /requireSnapshotScoreProgram/)
  assert.match(source, /requireRowScoreProgram/)
  assert.match(source, /requireEntryScoreProgram/)
  assert.match(source, /reconstructRoot/)
  assert.match(source, /\.limit\(pagination\.limit\)/)
  assert.match(source, /\.offset\(pagination\.offset\)/)
  assert.match(source, /epochTrustClass/)
  assert.match(source, /accessPolicy/)
  assert.match(source, /reducedRecomputeStatus/)
  assert.match(source, /ownerNodeId/)
  assert.doesNotMatch(source, /event\.content|eventContent|plaintext/)
})
