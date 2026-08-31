import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { easExpirationFoldTimestamp, easFoldTimestamp } from './eas-fold-time'

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

test('an importer expiration marker must match canonical EAS storage', () => {
  assert.equal(
    easExpirationFoldTimestamp(importedYearsLater, 1_710_000_000n),
    1_710_000_000n
  )
  assert.throws(
    () => easExpirationFoldTimestamp(importedYearsLater, 1_710_000_001n),
    /does not match EAS expirationTime/
  )
})

test('EAS handlers persist authenticated fold times, never delayed event times', () => {
  const source = readFileSync(new URL('./eas.ts', import.meta.url), 'utf8')
  const importerAbi = readFileSync(
    new URL('../abis/onchainAttestationImporter.ts', import.meta.url),
    'utf8'
  )
  const config = readFileSync(
    new URL('../ponder.config.ts', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(source, /timestamp: event\.block\.timestamp/)
  assert.doesNotMatch(source, /blockTimestamp: event\.block\.timestamp/)
  assert.match(source, /easFoldTimestamp\(attestation, 'attest'\)/)
  assert.match(source, /easFoldTimestamp\(attestation, 'revoke'\)/)
  assert.match(source, /onchainAttestationImporter:ExpirationImported/)
  assert.match(source, /easExpirationFoldTimestamp\(attestation, timestamp\)/)
  assert.match(
    source.match(/const onAttested[\s\S]*?const onRevoked/)?.[0] ?? '',
    /onConflictDoNothing\(\)/,
    'the same canonical EAS UID must be importable into multiple accumulators'
  )
  assert.match(importerAbi, /name: 'ExpirationImported'/)
  assert.match(config, /onchainAttestationImporter:/)
})
