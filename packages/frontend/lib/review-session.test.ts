import assert from 'node:assert/strict'
import test from 'node:test'

import { createReviewSession } from './review-session'

test('late preparation cannot publish after account, network, reset, or a newer review changes', async () => {
  for (const change of ['account', 'network', 'reset', 'new review']) {
    const session = createReviewSession()
    session.setContext('account-a:network-a')
    const operation = session.capture()
    let release!: () => void
    let published = false
    const task = (async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      operation.assertActive()
      published = true
    })()
    if (change === 'account' || change === 'network') session.setContext(change)
    else session.invalidate()
    release()
    await assert.rejects(task, /changed/)
    assert.equal(published, false)
    assert.equal(operation.active(), false)
    assert.equal(session.capture().active(), true)
  }
})

test('ordinary renders preserve a reviewed operation until it is explicitly replaced', () => {
  const session = createReviewSession()
  session.setContext('account-a:network-a')
  const operation = session.capture()
  session.setContext('account-a:network-a')
  assert.doesNotThrow(operation.assertActive)
})
