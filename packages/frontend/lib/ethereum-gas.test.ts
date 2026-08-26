import assert from 'node:assert/strict'

import {
  ETHEREUM_TRANSACTION_GAS_CAP,
  bufferedEthereumGasLimit,
} from './ethereum-gas'

assert.equal(bufferedEthereumGasLimit(100n), 125n)
assert.equal(bufferedEthereumGasLimit(101n), 127n)

// Regression: Infura returned this already-padded estimate for governed creation. Applying the
// UI's former uncapped 25% margin produced 20,611,581, which Sepolia rejects before execution.
assert.equal(
  bufferedEthereumGasLimit(16_489_265n),
  ETHEREUM_TRANSACTION_GAS_CAP
)
assert.equal(ETHEREUM_TRANSACTION_GAS_CAP, 16_777_216n)

console.log('ethereum-gas tests passed')
