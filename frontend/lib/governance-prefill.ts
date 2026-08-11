import type { Hex } from 'viem'

export type GovernancePrefillAction = {
  target: string
  value: string
  data: string
  operation: number
  description?: string
}

export type GovernancePrefill = {
  networkId: string
  fingerprint: Hex
  parentHash: Hex
  proposedHash: Hex
  title: string
  description: string
  actions: GovernancePrefillAction[]
  createdAt: number
}

const key = (networkId: string, fingerprint: string) =>
  `trustgraph:governance-prefill:${networkId}:${fingerprint}`

export const saveGovernancePrefill = (prefill: GovernancePrefill) => {
  window.localStorage.setItem(
    key(prefill.networkId, prefill.fingerprint),
    JSON.stringify(prefill)
  )
}

export const loadGovernancePrefill = (
  networkId: string,
  fingerprint: string | null
): GovernancePrefill | null => {
  if (!fingerprint || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key(networkId, fingerprint))
    if (!raw) return null
    const parsed = JSON.parse(raw) as GovernancePrefill
    return parsed.networkId === networkId && parsed.fingerprint === fingerprint
      ? parsed
      : null
  } catch {
    return null
  }
}

export const clearGovernancePrefill = (
  networkId: string,
  fingerprint: string
) => window.localStorage.removeItem(key(networkId, fingerprint))
