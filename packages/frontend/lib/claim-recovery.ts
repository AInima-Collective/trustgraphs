import { TransactionReceiptNotFoundError } from 'viem'

export type ClaimRecovery =
  | 'confirmed'
  | 'reverted'
  | 'missing'
  | 'unavailable'
  | 'changed'
  | 'cleared'

/** Only an explicit missing receipt permits a person to clear local pending tracking. */
export async function checkClaimReceipt(
  read: () => Promise<{ status: 'success' | 'reverted' }>
): Promise<ClaimRecovery> {
  try {
    const receipt = await read()
    return receipt.status === 'success' ? 'confirmed' : 'reverted'
  } catch (error) {
    return error instanceof TransactionReceiptNotFoundError
      ? 'missing'
      : 'unavailable'
  }
}

export const samePendingClaim = (
  current: { hash: string; status: 'submitted' | 'confirmed' } | undefined,
  checkedHash: string
) => current?.status === 'submitted' && current.hash === checkedHash
