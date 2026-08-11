import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveParameterVersionStates } from './params-shared'

test('a newly executed version waits while the prior pinned version remains active', () => {
  const states = deriveParameterVersionStates(
    [
      { version: 2n, firstCheckpoint: null, valid: true },
      { version: 1n, firstCheckpoint: 4n, valid: true },
    ],
    2n
  )
  assert.equal(states.get(1n), 'active')
  assert.equal(states.get(2n), 'current-unpinned')
})

test('the first pin activates the new version and supersedes every older version', () => {
  const states = deriveParameterVersionStates(
    [
      { version: 3n, firstCheckpoint: 9n, valid: true },
      { version: 2n, firstCheckpoint: 7n, valid: true },
      { version: 1n, firstCheckpoint: 4n, valid: true },
    ],
    3n
  )
  assert.equal(states.get(3n), 'active')
  assert.equal(states.get(2n), 'superseded')
  assert.equal(states.get(1n), 'superseded')
})

test('an inconsistent event is diagnostic data and never becomes active', () => {
  const states = deriveParameterVersionStates(
    [
      { version: 2n, firstCheckpoint: 9n, valid: false },
      { version: 1n, firstCheckpoint: 4n, valid: true },
    ],
    1n
  )
  assert.equal(states.get(2n), 'inconsistent')
  assert.equal(states.get(1n), 'active')
})
