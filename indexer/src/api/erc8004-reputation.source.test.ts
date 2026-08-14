import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./erc8004.ts', import.meta.url), 'utf8')

test('raw feedback route stays keyset-paginated and bulk-loaded', () => {
  assert.match(source, /app\.get\('\/feedback'/)
  assert.match(source, /desc\(erc8004Feedback\.blockNumber\)/)
  assert.match(source, /desc\(erc8004Feedback\.transactionIndex\)/)
  assert.match(source, /desc\(erc8004Feedback\.logIndex\)/)
  assert.match(source, /\.limit\(query\.limit \+ 1\)/)
  assert.match(
    source,
    /inArray\(erc8004FeedbackResponse\.feedbackId, feedbackIds\)/
  )
  assert.match(source, /latestReputationDocumentsFor\(\[/)
  assert.match(source, /score: false/)
  assert.doesNotMatch(source, /readAllFeedback/)
})

test('descriptor work remains outside Ponder event handlers', () => {
  assert.match(source, /app\.get\('\/feedback-metadata-tasks'/)
  const handler = readFileSync(
    new URL('../erc8004-reputation.ts', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(handler, /fetchReputationDocument|fetch\(/)
})
