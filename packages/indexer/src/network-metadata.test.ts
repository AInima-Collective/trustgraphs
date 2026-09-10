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

test('every snapshot-backed tier updates current state and appends history', () => {
  const handler = readFileSync(new URL('./merkle.ts', import.meta.url), 'utf8')
  assert.match(handler, /merkleSnapshot:MetadataURIUpdated/)
  assert.match(handler, /weightedMerkleSnapshot:MetadataURIUpdated/)
  assert.match(handler, /compositionMerkleSnapshot:MetadataURIUpdated/)
  assert.match(handler, /contributionsMerkleSnapshot:MetadataURIUpdated/)
  assert.match(handler, /update\(instance/)
  assert.match(handler, /update\(weightedPriorInstance/)
  assert.match(handler, /update\(compositionInstance/)
  assert.match(handler, /update\(contributionsInstance/)
  assert.match(handler, /insert\(networkMetadataRevision\)/)

  const schema = readFileSync(
    new URL('../ponder.schema.ts', import.meta.url),
    'utf8'
  )
  assert.match(schema, /export const networkMetadataRevision/)
  assert.match(schema, /instanceRevisionIdx/)
  assert.match(schema, /snapshotRevisionIdx/)
})

test('composition and contributions creation seed revision zero', () => {
  for (const file of ['./composition.ts', './contributions-factory.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(source, /fetchNetworkMetadata\(metadataURI\)/)
    assert.match(source, /metadataRevision: 0n/)
    assert.match(source, /insert\(networkMetadataRevision\)/)
  }
})

test('composition and contributions APIs expose current metadata and history', () => {
  const compositionApi = readFileSync(
    new URL('./api/compositions.ts', import.meta.url),
    'utf8'
  )
  assert.match(
    compositionApi,
    /metadataRevision: row\.metadataRevision\.toString\(\)/
  )
  assert.match(compositionApi, /\/:instanceId\/metadata-revisions/)

  const contributionsApi = readFileSync(
    new URL('./api/contributions.ts', import.meta.url),
    'utf8'
  )
  assert.match(
    contributionsApi,
    /metadataRevision: row\.metadataRevision\.toString\(\)/
  )
  assert.match(contributionsApi, /\/instances\/:id\/metadata-revisions/)
})
