import assert from 'node:assert/strict'

import type { Config } from '@wagmi/core'
import type { Address } from 'viem'

import {
  EnsNameNotFoundError,
  EnsResolutionChangedError,
  InvalidAccountIdentifierError,
  resolveAccountIdentifierNow,
  resolveEnsNameNow,
} from './ens-query'

const config = {} as Config
const original = '0x1111111111111111111111111111111111111111' as Address
const changed = '0x2222222222222222222222222222222222222222' as Address

const main = async () => {
  let lookupCount = 0
  const resolved = await resolveEnsNameNow(
    config,
    ' Alice.ETH ',
    11155111,
    async (name, coinType) => {
      lookupCount++
      assert.equal(name, 'alice.eth')
      assert.equal(coinType, 60n)
      return original
    }
  )
  assert.equal(resolved.ensName, 'alice.eth')
  assert.equal(resolved.address, original)
  assert.equal(lookupCount, 1)

  const directAddress = await resolveAccountIdentifierNow(
    config,
    original,
    10,
    null,
    async () => {
      throw new Error('Address input must not trigger ENS resolution')
    }
  )
  assert.equal(directAddress.address, original)

  await assert.rejects(
    resolveEnsNameNow(config, 'missing.eth', 10, async () => null),
    EnsNameNotFoundError
  )
  await assert.rejects(
    resolveEnsNameNow(
      config,
      'zero.eth',
      10,
      async () => '0x0000000000000000000000000000000000000000'
    ),
    EnsNameNotFoundError
  )
  await assert.rejects(
    resolveAccountIdentifierNow(config, 'not an account', 10),
    InvalidAccountIdentifierError
  )

  const unchanged = await resolveAccountIdentifierNow(
    config,
    'alice.eth',
    10,
    original,
    async () => original
  )
  assert.equal(unchanged.address, original)

  await assert.rejects(
    resolveAccountIdentifierNow(
      config,
      'alice.eth',
      10,
      original,
      async () => changed
    ),
    (error: unknown) => {
      assert.ok(error instanceof EnsResolutionChangedError)
      assert.equal(error.previousAddress, original)
      assert.equal(error.currentAddress, changed)
      return true
    }
  )

  console.log('ENS live-resolution boundary tests passed')
}

void main()
