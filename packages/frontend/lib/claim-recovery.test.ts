import assert from 'node:assert/strict'
import test from 'node:test'

import { TransactionReceiptNotFoundError } from 'viem'

import { checkClaimReceipt, samePendingClaim } from './claim-recovery'

const hash = `0x${'ab'.repeat(32)}` as const

test('recovery distinguishes a missing transaction from an RPC failure and confirmed/reverted receipts', async () => {
  assert.equal(
    await checkClaimReceipt(async () => ({ status: 'success' })),
    'confirmed'
  )
  assert.equal(
    await checkClaimReceipt(async () => ({ status: 'reverted' })),
    'reverted'
  )
  assert.equal(
    await checkClaimReceipt(async () => {
      throw new TransactionReceiptNotFoundError({ hash })
    }),
    'missing'
  )
  assert.equal(
    await checkClaimReceipt(async () => {
      throw new Error('RPC unavailable')
    }),
    'unavailable'
  )
})

test('a delayed clear cannot erase a repriced, confirmed, or different account claim', () => {
  assert.equal(samePendingClaim({ hash, status: 'submitted' }, hash), true)
  assert.equal(
    samePendingClaim({ hash: 'replacement', status: 'submitted' }, hash),
    false
  )
  assert.equal(samePendingClaim({ hash, status: 'confirmed' }, hash), false)
  assert.equal(samePendingClaim(undefined, hash), false)
})
