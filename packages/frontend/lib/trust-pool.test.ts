import assert from 'node:assert/strict'
import test from 'node:test'

import {
  governorStateLabel,
  governorStatePriority,
  poolShare,
  proposalBody,
  proposalTitle,
  shortProposalId,
} from './trust-pool'

const ID =
  '38349718221419349318633421235294536287138745298373102094781325419128317213117'

test('a proposal title is its first markdown line', () => {
  assert.equal(
    proposalTitle('# GCP-12: Fund the stack\n\nBody', ID),
    'GCP-12: Fund the stack'
  )
  assert.equal(proposalTitle('\n\n## Second level\nBody', ID), 'Second level')
  assert.equal(proposalTitle('Plain first line\nBody', ID), 'Plain first line')
  assert.equal(proposalTitle('   \n#\n', ID), 'Proposal 383497…3117')
  assert.equal(proposalBody('# Title\n\nThe body'), 'The body')
  assert.equal(proposalBody('No heading'), 'No heading')
  assert.equal(shortProposalId('42'), '42')
})

test('pool shares floor exactly like TrustPool.vote', () => {
  const poolVotes = 900_000n * 10n ** 18n
  assert.equal(poolShare(poolVotes, 600n, 1000n), 540_000n * 10n ** 18n)
  assert.equal(poolShare(10n, 1n, 3n), 3n)
  assert.equal(poolShare(10n, 1n, 0n), 0n)
})

test('governor states read in OZ enum order and sort voting first', () => {
  assert.equal(governorStateLabel(0), 'Pending')
  assert.equal(governorStateLabel(1), 'Active')
  assert.equal(governorStateLabel(7), 'Executed')
  assert.equal(governorStateLabel(8), 'Unknown')
  assert.equal(governorStateLabel(undefined), 'Unknown')
  assert.deepEqual(
    [3, 0, 1, 7].sort(
      (a, b) => governorStatePriority(a) - governorStatePriority(b)
    ),
    [1, 0, 3, 7]
  )
})
