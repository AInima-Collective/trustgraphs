import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { distributeArgs, quotedFee } from './funding-terms'

const DIST = '0x00000000000000000000000000000000000000d1' as const
const ROOT =
  '0x1111111111111111111111111111111111111111111111111111111111111111' as const
const FEE_RANGE = 10n ** 18n

test('the quoted fee is the contract formula, not a rounded percent', () => {
  // 2.5% of 1000e18. A float percent (2.5) cannot be a BigInt at all, which is what the
  // indexer-derived display value used to attempt.
  const fee = quotedFee(1000n * 10n ** 18n, 25n * 10n ** 15n, FEE_RANGE)
  assert.equal(fee, 25n * 10n ** 18n)
})

test('a zero FEE_RANGE is refused rather than dividing by zero', () => {
  assert.throws(() => quotedFee(1n, 1n, 0n), /FEE_RANGE is zero/)
})

test('distribute args are built in ABI order with every guard populated', () => {
  const args = distributeArgs({
    token: DIST,
    amount: 100n,
    expectedRoot: ROOT,
    expectedTotalMerkleValue: 4200n,
    claimDeadline: 0n,
    feePercentage: 10n ** 16n, // 1%
    feeRange: FEE_RANGE,
    feeRecipient: DIST,
  })
  assert.deepEqual(args, [DIST, 100n, ROOT, 4200n, 0n, 1n, DIST])
})

test('distribute has exactly one form, and it is the guarded one', () => {
  // The audit closed H-3 by adding a guarded overload that no caller used. Deleting the unguarded
  // forms is what made the guard load-bearing; this pins that they stay deleted.
  const abi = JSON.parse(
    // Resolved from the package root: this file is compiled into node_modules/.cache before it
    // runs, so __dirname points at the cache rather than at lib/.
    fs.readFileSync(
      path.join(process.cwd(), 'abis/MerkleFundDistributor.json'),
      'utf8'
    )
  ).abi as Array<{ type: string; name?: string; inputs?: unknown[] }>
  const forms = abi.filter(
    (e) => e.type === 'function' && e.name === 'distribute'
  )
  assert.equal(forms.length, 1, 'distribute must not be overloaded')
  assert.equal(forms[0].inputs?.length, 7)
})
