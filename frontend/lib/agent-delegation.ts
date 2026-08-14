import type { Hex } from 'viem'

export interface AgentNotificationConfirmation {
  delegate: Hex
  channelLabel: string
  confirmedAt: number
}

const storageKey = (networkId: string, module: Hex, principal: Hex) =>
  `trustgraphs:vote-delegation:${networkId}:${module.toLowerCase()}:${principal.toLowerCase()}`

export const loadAgentNotificationConfirmation = (
  networkId: string,
  module: Hex,
  principal: Hex
): AgentNotificationConfirmation | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(
      storageKey(networkId, module, principal)
    )
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<AgentNotificationConfirmation>
    if (
      typeof value.delegate !== 'string' ||
      !/^0x[0-9a-fA-F]{40}$/.test(value.delegate) ||
      typeof value.channelLabel !== 'string' ||
      value.channelLabel.trim().length < 3 ||
      typeof value.confirmedAt !== 'number' ||
      !Number.isSafeInteger(value.confirmedAt)
    ) {
      return null
    }
    return {
      delegate: value.delegate as Hex,
      channelLabel: value.channelLabel.trim(),
      confirmedAt: value.confirmedAt,
    }
  } catch {
    return null
  }
}

export const saveAgentNotificationConfirmation = (
  networkId: string,
  module: Hex,
  principal: Hex,
  confirmation: AgentNotificationConfirmation
): boolean => {
  if (typeof window === 'undefined') return false
  try {
    window.localStorage.setItem(
      storageKey(networkId, module, principal),
      JSON.stringify(confirmation)
    )
    return true
  } catch {
    return false
  }
}

export const clearAgentNotificationConfirmation = (
  networkId: string,
  module: Hex,
  principal: Hex
) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(storageKey(networkId, module, principal))
  } catch {
    // Revocation is authoritative on-chain; unavailable browser storage must not obscure it.
  }
}
