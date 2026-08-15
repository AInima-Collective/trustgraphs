import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { keccak256 } from 'viem'

import {
  journalEncoded,
  paramsEncoded,
  productionGolden,
  sourcePolicyRoot,
} from './production'

const checkedIn = () =>
  JSON.parse(
    readFileSync(
      new URL('../../test/golden/trust-compose.json', import.meta.url),
      'utf8'
    )
  )

test('production params, capture, output, proof, and journal vector is current', () => {
  const generated = productionGolden()
  assert.deepEqual(generated, checkedIn())
  assert.equal(
    keccak256(paramsEncoded(generated.params)),
    generated.params.paramsHash
  )
  assert.equal(
    keccak256(journalEncoded(generated.journal)),
    generated.journal.digest
  )
})

test('source policy root is independent of source enumeration order', () => {
  const generated = productionGolden()
  const sources = generated.policyManifest.entries
  assert.equal(sourcePolicyRoot(sources), generated.policyManifest.root)
  assert.equal(
    sourcePolicyRoot([...sources].reverse()),
    generated.policyManifest.root
  )
})
