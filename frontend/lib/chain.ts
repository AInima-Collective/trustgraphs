'use client'

import {
  WaitForTransactionReceiptReturnType,
  WriteContractParameters,
  waitForTransactionReceipt,
  writeContract,
} from '@wagmi/core'
import {
  Abi,
  ContractFunctionArgs,
  ContractFunctionName,
  type ReplacementReason,
} from 'viem'

import { makeWagmiConfig } from './wagmi'

export class TransactionReplacementError extends Error {
  constructor(public readonly reason: Exclude<ReplacementReason, 'repriced'>) {
    super(`Transaction was ${reason} before the requested call was confirmed.`)
    this.name = 'TransactionReplacementError'
  }
}

/**
 * Write a contract and wait for it to be confirmed.
 *
 * DO NOT USE THIS FUNCTION DIRECTLY. USE THE `txToast` FUNCTION INSTEAD.
 */
export const writeEthContractAndWait = async <
  cfg extends ReturnType<typeof makeWagmiConfig>,
  abi extends Abi | readonly unknown[],
  functionName extends ContractFunctionName<abi, 'nonpayable' | 'payable'>,
  args extends ContractFunctionArgs<
    abi,
    'nonpayable' | 'payable',
    functionName
  >,
  chainId extends cfg['chains'][number]['id'],
>(
  parameters: WriteContractParameters<abi, functionName, args, cfg, chainId>,
  {
    confirmations = 3,
    onTransactionSent,
    onConfirmation,
  }: {
    /**
     * Number of confirmations to wait for.
     *
     * Defaults to 3.
     */
    confirmations?: number
    /**
     * Callback to call after the transaction hash is generated.
     */
    onTransactionSent?: (hash: `0x${string}`) => void
    /**
     * Callback to call when confirmations increase.
     */
    onConfirmation?: (confirmations: number, hash: `0x${string}`) => void
  } = {}
): Promise<WaitForTransactionReceiptReturnType<cfg, chainId>> => {
  const hash = await writeContract(makeWagmiConfig() as any, parameters as any)
  onTransactionSent?.(hash)

  // Recursively wait for confirmations until the target is reached so we can fire the callback.
  const checkConfirmations = async (
    targetConfirmations: number
  ): Promise<WaitForTransactionReceiptReturnType<cfg, chainId>> => {
    let terminalReplacement: Exclude<ReplacementReason, 'repriced'> | null =
      null
    const receipt = await waitForTransactionReceipt(makeWagmiConfig(), {
      confirmations: targetConfirmations,
      hash,
      onReplaced: ({ reason }) => {
        // A fee-only repricing still executes the requested call. A cancellation or unrelated
        // same-nonce replacement does not, and must never inherit this transaction's success copy.
        if (reason !== 'repriced') terminalReplacement = reason
      },
    })
    if (terminalReplacement) {
      throw new TransactionReplacementError(terminalReplacement)
    }
    onConfirmation?.(targetConfirmations, hash)

    return targetConfirmations >= confirmations
      ? (receipt as unknown as WaitForTransactionReceiptReturnType<
          cfg,
          chainId
        >)
      : checkConfirmations(targetConfirmations + 1)
  }

  return checkConfirmations(1)
}
