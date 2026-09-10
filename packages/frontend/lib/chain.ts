'use client'

import {
  type ApplicationTransactionOptions,
  type ApplicationTransactionParameters,
  writeApplicationContractAndWait,
} from './application-transaction'
import { getTargetChainConfig, makeWagmiConfig } from './wagmi'

export { TransactionReplacementError } from './application-transaction'

/** Write on the deployment chain and wait for its receipt. Use txToast in UI flows. */
export const writeEthContractAndWait = (
  parameters: ApplicationTransactionParameters,
  options: ApplicationTransactionOptions = {}
) =>
  writeApplicationContractAndWait(
    makeWagmiConfig(),
    getTargetChainConfig(),
    parameters,
    options
  )
