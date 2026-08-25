import assert from 'node:assert/strict'
import test from 'node:test'

import { redactSecrets } from '../../scripts/redact-secrets.cjs'

test('redacts provider keys in URL paths and query strings', () => {
  const redacted = redactSecrets(
    'path https://rpc.example/v2/path-secret query https://rpc.example?apikey=query-secret'
  )

  assert.equal(
    redacted,
    'path https://rpc.example/<redacted> query https://rpc.example/<redacted>'
  )
  assert.doesNotMatch(redacted, /path-secret|query-secret/)
})

test('redacts URL userinfo without treating it as a provider host', () => {
  const redacted = redactSecrets(
    'connecting to https://service-user:password-secret@rpc.example'
  )

  assert.equal(redacted, 'connecting to https://rpc.example/<redacted>')
  assert.doesNotMatch(redacted, /service-user|password-secret/)
})

test('keeps a bare provider origin useful in logs', () => {
  assert.equal(
    redactSecrets('connecting to https://rpc.example:8545'),
    'connecting to https://rpc.example:8545'
  )
})
