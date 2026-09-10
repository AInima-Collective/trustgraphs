import assert from 'node:assert/strict'
import test from 'node:test'

import {
  contractReadState,
  distributionClosed,
  financialProofReady,
  financialReadState,
  formatFinancialAmount,
  parseFinancialAmount,
  verifiedTokenMetadata,
} from './financial-state'

test('mixed-token amounts and fees preserve each token precision without Number conversion', () => {
  const usdc = { symbol: 'USDC', decimals: 6 }
  const eth = { symbol: 'ETH', decimals: 18 }
  assert.equal(formatFinancialAmount(100_000_000n, usdc), '100 USDC')
  assert.equal(formatFinancialAmount(1_000_000n, usdc), '1 USDC')
  assert.equal(formatFinancialAmount(100_000_000n, eth), '0.0000000001 ETH')
  assert.equal(
    formatFinancialAmount(9_007_199_254_740_993_123456n, usdc),
    '9,007,199,254,740,993.123456 USDC'
  )
  assert.equal(formatFinancialAmount(1n, undefined), 'Amount unavailable')
  assert.equal(
    formatFinancialAmount(1n, { symbol: 'WHOLE', decimals: 0 }),
    '1 WHOLE'
  )
})

test('missing or failed proof data never becomes a verified absence or authorizes a claim', () => {
  assert.equal(financialProofReady(undefined), false)
  assert.equal(financialProofReady({ data: undefined, isError: false }), false)
  assert.equal(financialProofReady({ data: null, isError: true }), false)
  assert.equal(
    financialProofReady({ data: { value: '100' }, isError: true }),
    false
  )
  assert.equal(financialProofReady({ data: null, isError: false }), true)
  assert.equal(
    financialProofReady({ data: { value: '100' }, isError: false }),
    true
  )
})

test('failed token decimals never assume eighteen or authorize an amount', () => {
  const symbol = { status: 'success', result: 'USDC' }
  assert.equal(
    verifiedTokenMetadata('0x123456', symbol, { status: 'failure' }),
    undefined
  )
  assert.equal(
    verifiedTokenMetadata('0x123456', symbol, {
      status: 'success',
      result: -1,
    }),
    undefined
  )
  assert.deepEqual(parseFinancialAmount('100', undefined), {
    amount: null,
    error: null,
  })
  assert.equal(
    verifiedTokenMetadata('0x123456', symbol, { status: 'success', result: 6 })
      ?.decimals,
    6
  )
})

test('funding amounts must be positive and representable exactly', () => {
  for (const input of ['-1', '0', '1e6', 'NaN', '1.0000001']) {
    const result = parseFinancialAmount(input, 6)
    assert.equal(result.amount, null, input)
    assert.ok(result.error, input)
  }
  assert.equal(parseFinancialAmount('.000001', 6).amount, 1n)
  assert.equal(parseFinancialAmount('1.0000000', 6).amount, 1_000_000n)
  assert.equal(parseFinancialAmount('0.1', 0).amount, null)
})

test('empty success, initial failure and failed refresh remain different states', () => {
  const ready = { data: [], isError: false, isPending: false }
  assert.equal(financialReadState([ready]), 'ready')
  assert.equal(
    financialReadState([{ data: undefined, isError: false, isPending: true }]),
    'loading'
  )
  assert.equal(
    financialReadState([ready, { data: undefined, isError: true }]),
    'error'
  )
  assert.equal(financialReadState([{ ...ready, isError: true }]), 'stale')
  assert.equal(
    contractReadState({ ...ready, data: [{ status: 'failure' }] }, 1),
    'error'
  )
})

test('expired or swept distributions are not claimable, including before the clock initializes', () => {
  assert.equal(
    distributionClosed({ sweptAmount: 1n, claimDeadline: 0n }, 100),
    true
  )
  assert.equal(
    distributionClosed({ sweptAmount: 0n, claimDeadline: 99n }, 100),
    true
  )
  assert.equal(
    distributionClosed({ sweptAmount: 0n, claimDeadline: 100n }, null),
    true
  )
  assert.equal(
    distributionClosed({ sweptAmount: 0n, claimDeadline: 100n }, 100),
    false
  )
  assert.equal(
    distributionClosed({ sweptAmount: 0n, claimDeadline: 0n }, 100),
    false
  )
})
