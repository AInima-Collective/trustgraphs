import assert from 'node:assert/strict'
import test from 'node:test'

import { tallyPoolCasts } from './trust-pool-shared'

test('pool casts fold per proposal in Bravo support order', () => {
  const tallies = tallyPoolCasts([
    { proposalId: 1n, support: 1, weight: 540n },
    { proposalId: 1n, support: 0, weight: 270n },
    { proposalId: 1n, support: 2, weight: 81n },
    { proposalId: 1n, support: 1, weight: 9n },
    { proposalId: 2n, support: 0, weight: 5n },
  ])
  assert.deepEqual(tallies.get(1n), {
    against: 270n,
    for: 549n,
    abstain: 81n,
    voters: 4,
  })
  assert.deepEqual(tallies.get(2n), {
    against: 5n,
    for: 0n,
    abstain: 0n,
    voters: 1,
  })
  assert.equal(tallies.get(3n), undefined)
})
