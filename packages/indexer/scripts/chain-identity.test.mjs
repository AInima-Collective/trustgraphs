import assert from 'node:assert/strict'
import test from 'node:test'

import {
  localSchemaName,
  parseRpcQuantity,
  parseStartBlock,
  sameChainIdentity,
  toBlockTag,
} from './chain-identity.mjs'

test('parses RPC quantities and block settings strictly', () => {
  assert.equal(parseRpcQuantity('0x7a'), 122)
  assert.equal(parseStartBlock(undefined, 1, 'START'), 1)
  assert.equal(parseStartBlock('242', 1, 'START'), 242)
  assert.equal(toBlockTag(242), '0xf2')
  assert.throws(() => parseRpcQuantity('242'), /not a valid/)
  assert.throws(() => parseStartBlock('-1', 1, 'START'), /non-negative/)
})

test('chain identity requires the recorded block number and hash', () => {
  const hash = `0x${'ab'.repeat(32)}`
  const stored = { anchor_block: '242', anchor_hash: hash.toUpperCase() }
  assert.equal(sameChainIdentity(stored, { number: 242, hash }), true)
  assert.equal(sameChainIdentity(stored, { number: 243, hash }), false)
  assert.equal(
    sameChainIdentity(stored, { number: 242, hash: `0x${'cd'.repeat(32)}` }),
    false
  )
})

test('local schema names are deterministic and safe', () => {
  const schema = localSchemaName(
    31337,
    {
      number: 5825,
      hash: `0x${'12'.repeat(32)}`,
    },
    'ab'.repeat(32)
  )
  assert.equal(schema, 'tg_dev_31337_5825_121212_abababab')
  assert.match(schema, /^[a-z0-9_]+$/)
  assert.ok(schema.length <= 45)
})
