import assert from 'node:assert/strict'
import { test } from 'node:test'

import { frontendOrigin, revalidationUrl } from './utils'

test('revalidation targets the local app outside production', () => {
  assert.equal(frontendOrigin({ DEPLOY_ENV: 'DEV' }), 'http://127.0.0.1:3000')
})

test('revalidation targets the hosted app in production', () => {
  assert.equal(
    frontendOrigin({ DEPLOY_ENV: 'PROD' }),
    'https://trustgraph.network'
  )
})

test('FRONTEND_URL overrides either default and trailing slashes are normalized', () => {
  const env = { DEPLOY_ENV: 'PROD', FRONTEND_URL: 'https://preview.example///' }
  assert.equal(frontendOrigin(env), 'https://preview.example')
  assert.equal(
    revalidationUrl('0xabc/def', env),
    'https://preview.example/api/revalidate/0xabc%2Fdef'
  )
})
