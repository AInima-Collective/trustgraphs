import assert from 'node:assert/strict'

import {
  ENS_MAINNET_COIN_TYPE,
  getEnsAddressCoinType,
  getEnsCoinType,
  isPotentialEnsName,
  normalizeEnsName,
  parseAccountIdentifier,
} from './ens'

assert.equal(isPotentialEnsName('vitalik.eth'), true)
assert.equal(isPotentialEnsName('ensfairy.xyz'), true)
assert.equal(isPotentialEnsName('ses.fkey.id'), true)
assert.equal(isPotentialEnsName(' 🦇️🔊️.eth '), true)

assert.equal(
  isPotentialEnsName('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'),
  false
)
assert.equal(isPotentialEnsName('ens.'), false)
assert.equal(isPotentialEnsName('.eth'), false)
assert.equal(isPotentialEnsName('vitalik'), false)

assert.equal(normalizeEnsName(' Alice.ETH '), 'alice.eth')
assert.equal(normalizeEnsName('a..eth'), null)
assert.equal(normalizeEnsName('not-a-name'), null)
assert.equal(getEnsCoinType(1), ENS_MAINNET_COIN_TYPE)
assert.equal(getEnsCoinType(11155111), ENS_MAINNET_COIN_TYPE)
assert.equal(getEnsCoinType(31337), ENS_MAINNET_COIN_TYPE)
assert.equal(getEnsCoinType(10), 2147483658n)
assert.equal(getEnsAddressCoinType(1), undefined)
assert.equal(getEnsAddressCoinType(11155111), undefined)
assert.equal(getEnsAddressCoinType(31337), undefined)
assert.equal(getEnsAddressCoinType(10), 2147483658n)

assert.deepEqual(parseAccountIdentifier(''), { kind: 'empty', input: '' })
assert.deepEqual(
  parseAccountIdentifier(' 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 '),
  {
    kind: 'address',
    input: ' 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 ',
    address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  }
)
assert.deepEqual(parseAccountIdentifier(' Alice.ETH '), {
  kind: 'ens',
  input: ' Alice.ETH ',
  name: 'alice.eth',
})
assert.deepEqual(parseAccountIdentifier('not an account'), {
  kind: 'invalid',
  input: 'not an account',
})

console.log('ENS input tests passed')
