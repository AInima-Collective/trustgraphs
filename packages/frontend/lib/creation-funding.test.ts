import assert from 'node:assert/strict'
import { test } from 'node:test'

import { reviewCreationFunding } from './creation-funding'

test('unfinished or invalid saved funding input is recoverable, with no payable policy', () => {
  for (const [prepayEth, maxPerRootUsd] of [
    ['unfinished', '25'],
    ['.', '25'],
    ['1e3', '25'],
    ['-1', '25'],
    ['0', '25'],
    ['0.0000000000000000001', '25'],
    ['1', 'unfinished'],
    ['1', '0'],
    ['1', '10001'],
  ]) {
    const result = reviewCreationFunding({ prepayEth, maxPerRootUsd }, 1n)
    assert.ok(
      result.problem,
      `${prepayEth}/${maxPerRootUsd} must block creation`
    )
    assert.deepEqual(result.initialPolicy, {
      minPaidIntervalBlocks: 0n,
      maxPerRootUsd: 0n,
    })
  }
})

test('optional blank funding and exact valid prepayment produce the intended policy', () => {
  const blank = reviewCreationFunding(
    { prepayEth: '', maxPerRootUsd: 'unfinished' },
    1n
  )
  assert.equal(blank.problem, null)
  assert.equal(blank.prepay, 0n)
  const funded = reviewCreationFunding(
    { prepayEth: '0.1', maxPerRootUsd: '25' },
    72n
  )
  assert.equal(funded.problem, null)
  assert.equal(funded.prepay, 100000000000000000n)
  assert.deepEqual(funded.initialPolicy, {
    minPaidIntervalBlocks: 72n,
    maxPerRootUsd: 2500000000n,
  })
})
