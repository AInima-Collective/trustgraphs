import assert from 'node:assert/strict'
import test from 'node:test'

import {
  boundedIngestionError,
  nextScoreBlobRetryBlock,
  scoreBlobRetryDelayBlocks,
} from './merkle-retry'

test('score blob retries back off without becoming permanently abandoned', () => {
  assert.equal(scoreBlobRetryDelayBlocks(1), 2n)
  assert.equal(scoreBlobRetryDelayBlocks(4), 16n)
  assert.equal(scoreBlobRetryDelayBlocks(20), 300n)
  assert.equal(nextScoreBlobRetryBlock(3_441n, 2), 3_445n)
})

test('persisted availability errors are bounded', () => {
  assert.equal(boundedIngestionError(new Error('offline')), 'offline')
  assert.equal(boundedIngestionError('x'.repeat(5_000)).length, 4_000)
})
