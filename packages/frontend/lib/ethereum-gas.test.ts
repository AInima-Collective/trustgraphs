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

// Regression: the weighted governed creation in the Sepolia report estimated 13,588,735 gas.
// The wallet added 50% and submitted 20,383,102; our bounded 25% margin must stay at the cap.
assert.equal(
  bufferedEthereumGasLimit(13_588_735n),
  ETHEREUM_TRANSACTION_GAS_CAP
)
assert.equal(ETHEREUM_TRANSACTION_GAS_CAP, 16_777_216n)

console.log('ethereum-gas tests passed')
