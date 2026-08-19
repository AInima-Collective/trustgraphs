import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_NOSTR_PAGE_LIMIT,
  MAX_NOSTR_PAGE_LIMIT,
  nostrPage,
} from './nostr-workspace-api-shared.ts'

test('Nostr workspace pagination is bounded and fail-closed', () => {
  assert.deepEqual(nostrPage(undefined, undefined), {
    limit: DEFAULT_NOSTR_PAGE_LIMIT,
    offset: 0,
  })
  assert.deepEqual(nostrPage(String(MAX_NOSTR_PAGE_LIMIT), '12'), {
    limit: MAX_NOSTR_PAGE_LIMIT,
    offset: 12,
  })
  for (const invalid of ['-1', '1.5', '01', 'NaN', '9007199254740992']) {
    assert.equal(nostrPage(invalid, undefined), null)
    assert.equal(nostrPage(undefined, invalid), null)
  }
  assert.equal(nostrPage(String(MAX_NOSTR_PAGE_LIMIT + 1), undefined), null)
})
