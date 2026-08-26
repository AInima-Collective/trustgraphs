/** EIP-7825's protocol-level maximum gas limit for one Ethereum transaction. */
export const ETHEREUM_TRANSACTION_GAS_CAP = 1n << 24n

/**
 * Keep the existing 25% estimation margin without constructing a transaction that Ethereum
 * clients must reject before execution. Some RPC providers already pad `eth_estimateGas`, so a
 * second uncapped margin can otherwise cross the EIP-7825 limit even when the call itself fits.
 */
export const bufferedEthereumGasLimit = (estimate: bigint): bigint => {
  const buffered = (estimate * 125n + 99n) / 100n
  return buffered > ETHEREUM_TRANSACTION_GAS_CAP
    ? ETHEREUM_TRANSACTION_GAS_CAP
    : buffered
}
