import assert from 'node:assert/strict'

import {
  PollingQuery,
  ROUTINE_INDEXER_QUERY_OPTIONS,
  createIndexerPollingPolicy,
} from './indexer-query-policy'

const query = (
  data: unknown,
  status: PollingQuery['state']['status'],
  dataUpdateCount: number,
  errorUpdateCount: number
): PollingQuery => ({
  state: { data, status, dataUpdateCount, errorUpdateCount },
})

const testMissingRows = () => {
  const interval = createIndexerPollingPolicy({
    baseMs: 10_000,
    maxMs: 60_000,
    stopAfter: 3,
  })
  const current = query(null, 'success', 1, 0)

  assert.equal(interval(current), 20_000, 'backs off after the first miss')
  assert.equal(interval(current), 20_000, 'does not count one result twice')

  current.state.dataUpdateCount = 2
  assert.equal(interval(current), 40_000, 'backs off again after a second miss')
  current.state.dataUpdateCount = 3
  assert.equal(interval(current), false, 'stops after repeated missing rows')

  current.state.data = { root: '0x1' }
  current.state.dataUpdateCount = 4
  assert.equal(interval(current), 10_000, 'healthy data revives normal polling')
}

const testErrors = () => {
  const interval = createIndexerPollingPolicy({ baseMs: 30_000 })
  const current = query(undefined, 'error', 0, 1)

  assert.equal(interval(current), 60_000, 'request errors use the same backoff')
  current.state.errorUpdateCount = 2
  assert.equal(interval(current), 120_000)
  current.state.errorUpdateCount = 3
  assert.equal(
    interval(current),
    false,
    'dead endpoints are not polled forever'
  )
}

const testPending = () => {
  const interval = createIndexerPollingPolicy({ baseMs: 10_000 })
  const current = query(undefined, 'pending', 0, 0)

  assert.equal(
    interval(current),
    10_000,
    'pending reads retain a future interval'
  )
}

testMissingRows()
testErrors()
testPending()

assert.equal(
  ROUTINE_INDEXER_QUERY_OPTIONS.retry,
  false,
  'routine indexer reads do not inherit the global retry burst'
)

console.log('indexer query policy tests passed')
