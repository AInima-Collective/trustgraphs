'use client'

import toast from 'react-hot-toast'
import { WaitForTransactionReceiptReturnType } from 'viem'

import { writeEthContractAndWait } from './chain'
import { parseErrorMessage } from './error'
import { makeWagmiConfig } from './wagmi'

export type TransactionToast = {
  /**
   * The TX to execute.
   */
  tx: Parameters<typeof writeEthContractAndWait>[0]
  /**
   * The message to display when the TX is successful.
   */
  successMessage: string
  /**
   * How many confirmations to wait for. Defaults to 3 for the last transaction (or if there is only one), and 1 for all preceding.
   */
  confirmations?: number
  /**
   * An optional callback with the transaction hash and index.
   */
  onTransactionSent?: (hash: `0x${string}`, index: number) => void
}

/**
 * Execute 1 or more transactions and display toasts as they are pending and execute/fail.
 */
export const txToast = async (...txs: TransactionToast[]) => {
  const wagmiConfig = makeWagmiConfig()
  const toastId = toast.loading('Preparing transaction...')

  const results: WaitForTransactionReceiptReturnType[] = []
  for (const [
    index,
    { tx, successMessage, confirmations: _confirmations, onTransactionSent },
  ] of txs.entries()) {
    const confirmations =
      _confirmations ??
      // On localhost, just wait for 1 confirmation.
      (wagmiConfig.chains.length === 1 && wagmiConfig.chains[0].id === 31337
        ? 1
        : // Use 1 for all preceding transactions, and 3 for the last one.
          index < txs.length - 1
          ? 1
          : 3)

    toast.loading('Waiting for signature...', { id: toastId })

    try {
      results.push(
        await writeEthContractAndWait(tx, {
          confirmations,
          onTransactionSent: (hash) => {
            onTransactionSent?.(hash, index)
            toast.loading(
              `Transaction sent! Waiting for ${confirmations} more confirmation${confirmations === 1 ? '' : 's'}...`,
              {
                id: toastId,
              }
            )
          },
          onConfirmation: (confirmed) => {
            const remainingConfirmations = confirmations - confirmed
            toast.loading(
              `Transaction sent! Waiting for ${
                remainingConfirmations
              } more confirmation${remainingConfirmations === 1 ? '' : 's'}...`,
              {
                id: toastId,
              }
            )
          },
        })
      )
      toast.success(successMessage, { id: toastId })
    } catch (err) {
      console.error('Transaction failed:', err)
      toast.error(`Transaction failed: ${parseErrorMessage(err)}`, {
        id: toastId,
      })
      throw err
    }
  }

  return results
}
