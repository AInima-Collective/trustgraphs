import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { easFoldTimestamp } from './eas-fold-time'

const importedYearsLater = {
  time: 1_700_000_000n,
  expirationTime: 1_710_000_000n,
  revocationTime: 1_720_000_000n,
}

test('fold timestamps come from EAS history rather than the import transaction', () => {
  const importBlockTimestamp = 1_900_000_000n
  assert.equal(easFoldTimestamp(importedYearsLater, 'attest'), 1_700_000_000n)
  assert.equal(easFoldTimestamp(importedYearsLater, 'expire'), 1_710_000_000n)
  assert.equal(easFoldTimestamp(importedYearsLater, 'revoke'), 1_720_000_000n)
  assert.notEqual(
    easFoldTimestamp(importedYearsLater, 'attest'),
    importBlockTimestamp
  )
})

test('a marker without the corresponding EAS timestamp fails closed', () => {
  const active = { time: 100n, expirationTime: 0n, revocationTime: 0n }
  assert.throws(() => easFoldTimestamp(active, 'expire'), /no expire timestamp/)
  assert.throws(() => easFoldTimestamp(active, 'revoke'), /no revoke timestamp/)
})

test('EAS handlers persist authenticated fold times, never delayed event times', () => {
  const source = readFileSync(new URL('./eas.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /timestamp: event\.block\.timestamp/)
  assert.doesNotMatch(source, /blockTimestamp: event\.block\.timestamp/)
  assert.match(source, /easFoldTimestamp\(attestation, 'attest'\)/)
  assert.match(source, /easFoldTimestamp\(attestation, 'revoke'\)/)
})
