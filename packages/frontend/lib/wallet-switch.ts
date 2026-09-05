export type WalletSwitchResult =
  | { ok: true }
  | { ok: false; cancelled: boolean; message: string }

const wasRejected = (error: unknown): boolean => {
  const seen = new Set<unknown>()
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    const value = error as { code?: number; name?: string; cause?: unknown }
    if (value.code === 4001 || value.name === 'UserRejectedRequestError')
      return true
    error = value.cause
  }
  return false
}

/** The active connector owns unknown-chain recovery. Never retry a rejected switch. */
export const requestApplicationChainSwitch = async (
  switchChain: () => Promise<unknown>,
  chainName: string
): Promise<WalletSwitchResult> => {
  try {
    await switchChain()
    return { ok: true }
  } catch (error) {
    const cancelled = wasRejected(error)
    return {
      ok: false,
      cancelled,
      message: cancelled
        ? 'Network switch cancelled. Your wallet is unchanged.'
        : `Could not switch to ${chainName}. Retry or select it in your wallet.`,
    }
  }
}
