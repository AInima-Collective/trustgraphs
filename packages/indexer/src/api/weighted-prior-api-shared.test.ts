import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  availabilityStatus,
  availabilityView,
  boundedInteger,
  serializeNormalizedEntries,
  versionStatus,
} from './weighted-prior-api-shared'

test('weighted pagination is bounded and rejects negative/non-integer input', () => {
  assert.equal(boundedInteger(undefined, 50, 200), 50)
  assert.equal(boundedInteger('999', 50, 200), 200)
  assert.equal(boundedInteger('-1', 50, 200), null)
  assert.equal(boundedInteger('1.5', 50, 200), null)
})

test('every documented version and availability filter is accepted', () => {
  for (const status of [
    'pending',
    'active',
    'superseded',
    'cancelled',
    'inconsistent',
  ]) {
    assert.equal(versionStatus(status), true)
  }
  for (const status of ['available', 'degraded', 'unavailable']) {
    assert.equal(availabilityStatus(status), true)
  }
  assert.equal(versionStatus('legacy'), false)
  assert.equal(availabilityStatus('substituted'), false)
})

test('provenance and unavailable/degraded diagnoses survive serialization', () => {
  assert.deepEqual(
    availabilityView({
      availability: 'unavailable',
      provenance: 'transaction',
      sourceTxHash: '0xsource',
      availabilityError: 'archival input pruned',
      verifiedAt: null,
    }),
    {
      status: 'unavailable',
      provenance: 'transaction',
      sourceTxHash: '0xsource',
      error: 'archival input pruned',
      verifiedAt: null,
    }
  )
  assert.equal(
    availabilityView({
      availability: 'degraded',
      provenance: 'cache',
      sourceTxHash: '0xsource',
      availabilityError: 'mirror timeout',
      verifiedAt: 123n,
    }).verifiedAt,
    '123'
  )
})

test('normalized weights are lossless decimal strings for paginated API clients', () => {
  assert.deepEqual(
    serializeNormalizedEntries([
      { position: 0, account: '0xabc', normalizedWeight: 999999999999999999n },
    ]),
    [
      {
        position: 0,
        account: '0xabc',
        normalizedWeight: '999999999999999999',
      },
    ]
  )
})

test('weighted routes are additive and leave the binary instance API mounted unchanged', () => {
  const routes = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  assert.match(routes, /app\.route\('\/instances', instances\)/)
  assert.match(routes, /app\.route\('\/weighted-priors', weightedPriors\)/)
  assert.doesNotMatch(routes, /app\.route\('\/instances', weightedPriors\)/)

  const handler = readFileSync(
    new URL('./weighted-priors.ts', import.meta.url),
    'utf8'
  )
  assert.match(handler, /app\.get\('\/:instanceId'/)
  assert.match(handler, /governanceFor\(\[row\]\)/)
  assert.match(handler, /module: governance\.address/)
  assert.match(handler, /safe: governance\.target/)
})
