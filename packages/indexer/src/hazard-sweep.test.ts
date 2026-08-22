/**
 * M0 invariant (GOAL "Non-negotiable invariants" #1): a valid chain never wedges the indexer.
 * Every subscribed event either updates an existing row, materializes it via an ensure, or
 * logs-and-skips with a warning. No bare `.update()` on a row a factory child (or a start-block
 * window) might not have; no silent catch; no silent skip.
 *
 * These are source pins for the 2026-08 hazard sweep. If one fails, either a hazard regressed or
 * a remedy was consciously redesigned — update the pin in the same commit either way.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (file: string) =>
  readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')

test('vault: every account/credit mutation is an upsert, never a bare update', () => {
  const source = read('vault.ts')
  assert.doesNotMatch(source, /\.update\(provingVaultAccount/)
  assert.doesNotMatch(source, /\.update\(provingVaultCredit/)
  assert.match(source, /const accountBaseline = /)
})

test('eas: a revocation materializes the attestation row by readback', () => {
  const source = read('eas.ts')
  assert.doesNotMatch(source, /\.update\(easAttestation/)
  assert.match(
    source,
    /insert\(easAttestation\)[\s\S]*?onConflictDoUpdate\(\{ revocationTime/
  )
})

test('graph-lineage: out-of-universe rows log-and-skip instead of throwing or bare-updating', () => {
  const source = read('graph-lineage.ts')
  assert.doesNotMatch(source, /throw new Error/)
  // Each of the four guarded sites names its skip.
  assert.ok(
    [...source.matchAll(/console\.warn/g)].length >= 4,
    'all four lineage/endorsement guards must warn'
  )
  // Every graphLineage/graphEndorsement update is preceded by a find guard in the same handler.
  for (const updated of source.matchAll(
    /\.update\((graphLineage|graphEndorsement),/g
  )) {
    const before = source.slice(0, updated.index)
    const handlerStart = before.lastIndexOf('ponder.on(')
    const handler = source.slice(handlerStart, updated.index)
    assert.match(
      handler,
      new RegExp(`db\\.find\\(${updated[1]}`),
      `${updated[1]} update at ${updated.index} must be find-guarded`
    )
  }
})

test('signer-sync: unobserved modules log-and-skip, never silently and never via bare update', () => {
  const source = read('signer-sync.ts')
  assert.doesNotMatch(source, /if \(!row\) return\n/)
  assert.ok([...source.matchAll(/console\.warn/g)].length >= 2)
  // The pause handler finds before it updates.
  const pause = source.match(
    /SignerSyncPausedUpdated[\s\S]*$/
  )?.[0] as string
  assert.ok(pause)
  assert.ok(
    pause.indexOf('db.find(signerSyncModule') <
      pause.indexOf('.update(signerSyncModule'),
    'pause handler must find before updating'
  )
})

test('erc8004: registry/agent/feedback events for pre-start-block state do not wedge', () => {
  const identity = read('erc8004.ts')
  // OwnershipTransferred is find-guarded; URIUpdated and MetadataSet upsert.
  assert.match(identity, /ownership transfer for unobserved registry/)
  assert.doesNotMatch(identity, /\.update\(erc8004Agent,/)

  const reputation = read('erc8004-reputation.ts')
  assert.match(reputation, /ownership transfer for unobserved registry/)
  assert.match(reputation, /revocation references unobserved/)
  assert.match(reputation, /response references unobserved/)
  assert.doesNotMatch(reputation, /revocation references unknown/)
  assert.doesNotMatch(reputation, /response references unknown/)
  // The pinned-owner drift check screams; it must not throw (a valid chain event cannot wedge us).
  assert.doesNotMatch(
    reputation,
    /throw new Error\(\s*`erc8004 reputation: Optimism owner changed/
  )
  assert.match(reputation, /console\.error\(\s*`erc8004 reputation: Optimism owner changed/)
})

test('score-program-binding: pre-start-block registrations log-and-skip', () => {
  const source = read('score-program-binding.ts')
  assert.doesNotMatch(source, /refused params update for unknown instance/)
  assert.match(source, /params-hash update for unobserved instance/)
})

test('composition: cancellations without an observed proposal log-and-skip', () => {
  const source = read('composition.ts')
  assert.doesNotMatch(
    source,
    /throw new Error\('composition cancellation has no matching proposal'\)/
  )
  assert.match(source, /has no matching observed proposal/)
})

test('ordering-safe sites carry their "safe because" comments', () => {
  for (const [file, near] of [
    ['params.ts', 'ParamsControllerCreated'],
    ['weighted-prior.ts', 'WeightedParamsControllerCreated'],
    ['composition.ts', 'TrustComposeParamsControllerCreated'],
  ] as const) {
    const source = read(file)
    const index = source.indexOf(near)
    assert.ok(index >= 0, `${file} still handles ${near}`)
    assert.match(
      source.slice(index, index + 1200),
      /Safe because/,
      `${file}'s ${near} handler must keep its ordering-safety comment`
    )
  }
})
