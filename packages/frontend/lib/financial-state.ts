import { formatUnits, parseUnits } from 'viem'

export type FinancialReadState = 'loading' | 'ready' | 'error' | 'stale'

export type FinancialRead = {
  data: unknown
  isError: boolean
  isPending?: boolean
}

/** A failed refresh may retain data, but that data must not authorize a payment. */
export function financialReadState(
  reads: readonly FinancialRead[]
): FinancialReadState {
  const failed = reads.filter((read) => read.isError)
  if (failed.length) {
    return failed.every((read) => read.data !== undefined) ? 'stale' : 'error'
  }
  return reads.some((read) => read.isPending || read.data === undefined)
    ? 'loading'
    : 'ready'
}

/** A resolved null is a verified absence; undefined or a failed refresh is not. */
export function financialProofReady(read: FinancialRead | undefined): boolean {
  return !!read && financialReadState([read]) === 'ready'
}

export type ContractResult = { status?: string; result?: unknown }

/** Multicall can resolve successfully while individual reads have failed. */
export function contractReadState(
  read: FinancialRead & { data: readonly ContractResult[] | undefined },
  count: number
): FinancialReadState {
  const state = financialReadState([read])
  if (state !== 'ready') return state
  return read.data?.length === count &&
    read.data.every((entry) => entry.status === 'success')
    ? 'ready'
    : 'error'
}

export type TokenMetadata = { decimals: number; symbol: string }

export const shortToken = (token: string) =>
  `${token.slice(0, 6)}…${token.slice(-4)}`

export function verifiedTokenMetadata(
  token: string,
  symbol: ContractResult | undefined,
  decimals: ContractResult | undefined
): TokenMetadata | undefined {
  if (
    decimals?.status !== 'success' ||
    typeof decimals.result !== 'number' ||
    !Number.isInteger(decimals.result) ||
    decimals.result < 0 ||
    decimals.result > 255
  )
    return undefined
  return {
    decimals: decimals.result,
    symbol:
      symbol?.status === 'success' &&
      typeof symbol.result === 'string' &&
      symbol.result.trim()
        ? symbol.result.trim()
        : shortToken(token),
  }
}

/** Keep the integer as an integer: Number() loses precision for real balances. */
export function formatFinancialAmount(
  value: bigint,
  metadata: TokenMetadata | undefined
): string {
  if (!metadata) return 'Amount unavailable'
  const [whole, fraction] = formatUnits(value, metadata.decimals).split('.')
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''} ${metadata.symbol}`
}

export function parseFinancialAmount(
  input: string,
  decimals: number | undefined
): { amount: bigint | null; error: string | null } {
  const value = input.trim()
  if (!value) return { amount: null, error: null }
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {
    return {
      amount: null,
      error: 'Enter a positive amount using digits and a decimal point.',
    }
  }
  if (decimals === undefined) return { amount: null, error: null }
  if ((value.split('.')[1]?.replace(/0+$/, '').length ?? 0) > decimals) {
    return {
      amount: null,
      error: `This token supports up to ${decimals} decimal places.`,
    }
  }
  const amount = parseUnits(value, decimals)
  return amount > 0n
    ? { amount, error: null }
    : { amount: null, error: 'Enter an amount greater than zero.' }
}

export function distributionClosed(
  distribution: { sweptAmount: bigint; claimDeadline: bigint },
  now: number | null
): boolean {
  return (
    distribution.sweptAmount > 0n ||
    (distribution.claimDeadline > 0n &&
      (now === null || BigInt(now) > distribution.claimDeadline))
  )
}
