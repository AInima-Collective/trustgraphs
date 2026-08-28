import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { validateNetworkMetadata } from './network-metadata.ts'

const valid = {
  name: 'Example network',
  description: 'A public description.',
  criteria: 'Vouch after working together.',
  image: 'ipfs://bafy-image',
  applicationUrl: 'https://example.org/join',
}

test('network metadata accepts the exact bounded five-field profile', () => {
  assert.deepEqual(validateNetworkMetadata(valid), valid)
  assert.deepEqual(
    validateNetworkMetadata({ ...valid, image: '', applicationUrl: '' }),
    { ...valid, image: '', applicationUrl: '' }
  )
})

test('network metadata rejects missing, extra, non-string, and empty-name fields', () => {
  const { criteria: _criteria, ...missing } = valid
  assert.equal(validateNetworkMetadata(missing), null)
  assert.equal(validateNetworkMetadata({ ...valid, extra: 'field' }), null)
  assert.equal(validateNetworkMetadata({ ...valid, criteria: 5 }), null)
  assert.equal(validateNetworkMetadata({ ...valid, name: '  ' }), null)
})

test('network metadata enforces UTF-8 byte caps and safe presentation URLs', () => {
  assert.equal(
    validateNetworkMetadata({ ...valid, name: 'é'.repeat(33) }),
    null
  )
  assert.equal(
    validateNetworkMetadata({ ...valid, image: 'javascript:x' }),
    null
  )
  assert.equal(
    validateNetworkMetadata({ ...valid, applicationUrl: 'data:text/plain,x' }),
    null
  )
})

test('standard and weighted snapshot events update current state and append history', () => {
  const handler = readFileSync(new URL('./merkle.ts', import.meta.url), 'utf8')
  assert.match(handler, /merkleSnapshot:MetadataURIUpdated/)
  assert.match(handler, /weightedMerkleSnapshot:MetadataURIUpdated/)
  assert.match(handler, /update\(instance/)
  assert.match(handler, /update\(weightedPriorInstance/)
  assert.match(handler, /insert\(networkMetadataRevision\)/)

  const schema = readFileSync(
    new URL('../ponder.schema.ts', import.meta.url),
    'utf8'
  )
  assert.match(schema, /export const networkMetadataRevision/)
  assert.match(schema, /instanceRevisionIdx/)
  assert.match(schema, /snapshotRevisionIdx/)
})
