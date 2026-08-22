import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('composition APIs are additive, paginated, and name both provenance classes', () => {
  const routes = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const source = readFileSync(
    new URL('./compositions.ts', import.meta.url),
    'utf8'
  )
  assert.match(routes, /app\.route\('\/compositions', compositions\)/)
  assert.match(source, /\/:instanceId\/policies/)
  assert.match(source, /\/:instanceId\/epochs/)
  assert.match(source, /\/sources'/)
  assert.match(source, /\/attribution'/)
  assert.match(source, /\/bundle'/)
  assert.match(source, /cryptographic:/)
  assert.match(source, /governance:/)
  assert.match(source, /\.limit\(pagination\.limit\)/)
  assert.match(source, /MAX|500/)
})
