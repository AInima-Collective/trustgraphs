import assert from 'node:assert/strict'

import {
  MAX_INITIAL_MAX_PER_ROOT_USD,
  VAULT_USD_SCALE,
  conservativeRefreshEstimate,
  initialPolicyForCreation,
  initialPolicyProblem,
  parseVaultUsd,
} from './proving-prepay'

assert.equal(parseVaultUsd('25'), 25n * VAULT_USD_SCALE)
assert.equal(parseVaultUsd('5.125'), 512_500_000n)
assert.equal(parseVaultUsd('10000'), MAX_INITIAL_MAX_PER_ROOT_USD)
assert.equal(parseVaultUsd('1.000000001'), null)

assert.match(initialPolicyProblem('1', '') ?? '', /most this tank may spend/)
assert.match(initialPolicyProblem('1', '0') ?? '', /nonzero/)
assert.match(initialPolicyProblem('1', '10000.00000001') ?? '', /\$10,000/)
assert.equal(initialPolicyProblem('', '0'), null)

assert.deepEqual(initialPolicyForCreation(0n, 99n, '25'), {
  minPaidIntervalBlocks: 0n,
  maxPerRootUsd: 0n,
})
assert.deepEqual(initialPolicyForCreation(10n ** 18n, 216_000n, '25'), {
  minPaidIntervalBlocks: 216_000n,
  maxPerRootUsd: 25n * VAULT_USD_SCALE,
})

assert.equal(
  conservativeRefreshEstimate(
    10n ** 18n,
    3_000n * VAULT_USD_SCALE,
    25n * VAULT_USD_SCALE
  ),
  120n
)
assert.equal(conservativeRefreshEstimate(0n, 3_000n, 25n), null)

console.log('proving-prepay tests passed')
