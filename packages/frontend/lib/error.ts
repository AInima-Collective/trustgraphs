import { getTargetChainConfig } from './wagmi'

/**
 * Map of recognized error messages to more helpful messages.
 */
const recognizedErrorMessages: Record<
  string,
  string | ((message: string, error: any) => string)
> = {
  'user rejected': 'You rejected the request.',
  'user denied': 'You rejected the request.',
  'nonce too low': 'Unexpected nonce conflict. Please try again.',
  'nonce too high': 'Unexpected nonce conflict. Please try again.',
  'transaction underpriced': 'Transaction fee too low. Please try again.',
  'returned no data': () =>
    `The contract did not respond as expected. Is your wallet connected to the correct network (${
      getTargetChainConfig().name
    })?`,
  'internal error':
    'An unexpected RPC error occurred. Please refresh the page to reconnect or try again later.',
  'internal json-rpc error':
    'An unexpected RPC error occurred. Please refresh the page to reconnect or try again later.',
}

/**
 * Parse errors into more helpful messages.
 */
export const parseErrorMessage = (err: any) => {
  const message = (
    err instanceof Error ? err.message : String(err)
  ).toLowerCase()

  // Attempt to recognize the error and return a more helpful message.
  for (const [key, value] of Object.entries(recognizedErrorMessages)) {
    if (message.includes(key.toLowerCase())) {
      return typeof value === 'function' ? value(message, err) : value
    }
  }

  return err.message
}

/**
 * Whether to retry a transaction error.
 */
export const shouldRetryTxError = (err: any) => {
  const message = (
    err instanceof Error ? err.message : String(err)
  ).toLowerCase()

  // Nonce conflicts or RPC errors.
  return (
    message.includes('nonce too low') ||
    message.includes('nonce too high') ||
    message.includes('transaction underpriced') ||
    message.includes('internal json-rpc error') ||
    message.includes('internal error')
  )
}
