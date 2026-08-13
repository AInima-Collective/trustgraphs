import assert from 'node:assert/strict'

import {
  FULL_SEED_TRUST_SHARE_PCT,
  hasUnreservedTrustShare,
  unreservedTrustSharePct,
} from './trust-share'

assert.equal(FULL_SEED_TRUST_SHARE_PCT, 100)
assert.equal(hasUnreservedTrustShare(100), false)
assert.equal(unreservedTrustSharePct(100), 0)

assert.equal(hasUnreservedTrustShare(99), true)
assert.equal(unreservedTrustSharePct(15), 85)

console.log('trust-share tests passed')
