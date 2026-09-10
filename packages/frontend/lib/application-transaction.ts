import {
  type Config,
  type SignTypedDataParameters,
  type WriteContractParameters,
  getConnection,
  signTypedData,
  waitForTransactionReceipt,
  writeContract,
} from '@wagmi/core'
import type {
  Address,
  Chain,
  Hash,
  ReplacementReason,
  TypedDataDomain,
  TypedDataParameter,
} from 'viem'

export class ApplicationChainMismatchError extends Error {
  constructor(chain: Pick<Chain, 'id' | 'name'>) {
    super(`Switch your wallet to ${chain.name} before continuing.`)
    this.name = 'ApplicationChainMismatchError'
  }
}

export class TransactionReplacementError extends Error {
  constructor(public readonly reason: Exclude<ReplacementReason, 'repriced'>) {
    super(`Transaction was ${reason} before the requested call was confirmed.`)
    this.name = 'TransactionReplacementError'
  }
}

/** Read the active connector itself: React's last chain snapshot can lag a wallet change. */
export const assertApplicationChain = async (
  config: Config,
  chain: Pick<Chain, 'id' | 'name'>,
  expectedAccount?: Address
) => {
  const connection = getConnection(config)
  if (!connection.isConnected || !connection.connector || !connection.address) {
    throw new Error('Connect your wallet before continuing.')
  }
  if ((await connection.connector.getChainId()) !== chain.id) {
    throw new ApplicationChainMismatchError(chain)
  }
  if (
    expectedAccount &&
    connection.address.toLowerCase() !== expectedAccount.toLowerCase()
  ) {
    throw new Error('Your wallet account changed. Review this action again.')
  }
  return { account: connection.address, connector: connection.connector }
}

export type ApplicationTypedData = {
  domain: TypedDataDomain
  types: Record<string, readonly TypedDataParameter[]>
  primaryType: string
  message: Record<string, unknown>
  account?: Address
}

/** The domain, account, and selected chain must agree before returning a relayable signature. */
export const signApplicationTypedData = async (
  config: Config,
  chain: Pick<Chain, 'id' | 'name'>,
  parameters: ApplicationTypedData
) => {
  if (Number(parameters.domain?.chainId) !== chain.id) {
    throw new ApplicationChainMismatchError(chain)
  }
  const connection = await assertApplicationChain(
    config,
    chain,
    typeof parameters.account === 'string' ? parameters.account : undefined
  )
  // EAS's SDK supplies runtime typed-data definitions. Viem validates those definitions when
  // signing; this adapter preserves every field while binding the account and application chain.
  const signature = await signTypedData(config, {
    ...parameters,
    ...connection,
  } as SignTypedDataParameters)
  await assertApplicationChain(config, chain, connection.account)
  return signature
}

export type ApplicationTransactionOptions = {
  confirmations?: number
  onTransactionSent?: (hash: Hash) => void
  onConfirmation?: (confirmations: number, hash: Hash) => void
}

// Transactions are queued with runtime ABIs, so callers cannot retain a specific
// payable function's generic type through the toast queue.
export type ApplicationTransactionParameters = Omit<
  WriteContractParameters,
  'value'
> & { value?: bigint }

/** Pin the wallet, account, execution chain, and receipt chain for the whole operation. */
export const writeApplicationContractAndWait = async (
  config: Config,
  chain: Pick<Chain, 'id' | 'name'>,
  parameters: ApplicationTransactionParameters,
  {
    confirmations = 3,
    onTransactionSent,
    onConfirmation,
  }: ApplicationTransactionOptions = {}
) => {
  if (parameters.chainId !== undefined && parameters.chainId !== chain.id) {
    throw new ApplicationChainMismatchError(chain)
  }
  const connection = await assertApplicationChain(
    config,
    chain,
    typeof parameters.account === 'string' ? parameters.account : undefined
  )
  let hash = await writeContract(config, {
    ...parameters,
    ...connection,
    chainId: chain.id,
  } as WriteContractParameters)
  onTransactionSent?.(hash)

  const target = Math.max(1, confirmations)
  for (let confirmed = 1; ; confirmed++) {
    let replacement: Exclude<ReplacementReason, 'repriced'> | undefined
    const receipt = await waitForTransactionReceipt(config, {
      chainId: chain.id,
      confirmations: confirmed,
      hash,
      onReplaced: (event) => {
        if (event.reason !== 'repriced') replacement = event.reason
        else if (hash !== event.transaction.hash) {
          hash = event.transaction.hash
          onTransactionSent?.(hash)
        }
      },
    })
    if (replacement) throw new TransactionReplacementError(replacement)
    onConfirmation?.(confirmed, hash)
    if (confirmed >= target) return receipt
  }
}
