import { type Hex, isHex } from 'viem'

import { normalizeSafeActions } from './actions'
import type { SafeAction } from './actions'

export type GovernancePrefillAction = SafeAction & {
  contractName?: string
  functionSignature?: string
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

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const bytes32 = (value: unknown): value is Hex =>
  typeof value === 'string' &&
  value.length === 66 &&
  isHex(value, { strict: true })

/** Parse the local-storage boundary without trusting a TypeScript assertion over JSON. */
export const parseGovernancePrefill = (
  raw: string,
  networkId: string,
  fingerprint: string
): GovernancePrefill | null => {
  try {
    const parsed = record(JSON.parse(raw))
    if (
      !parsed ||
      parsed.networkId !== networkId ||
      parsed.fingerprint !== fingerprint ||
      !bytes32(parsed.fingerprint) ||
      !bytes32(parsed.parentHash) ||
      !bytes32(parsed.proposedHash) ||
      typeof parsed.title !== 'string' ||
      typeof parsed.description !== 'string' ||
      typeof parsed.createdAt !== 'number' ||
      !Number.isFinite(parsed.createdAt) ||
      parsed.createdAt < 0 ||
      !Array.isArray(parsed.actions)
    ) {
      return null
    }

    const normalized = normalizeSafeActions(parsed.actions)
    if (!normalized.ok) return null
    const actions: GovernancePrefillAction[] = []
    for (let index = 0; index < normalized.actions.length; index++) {
      const source = record(parsed.actions[index])!
      const contractName = source.contractName
      const functionSignature = source.functionSignature
      const normalizedContractName =
        typeof contractName === 'string' ? contractName : undefined
      const normalizedFunctionSignature =
        typeof functionSignature === 'string' ? functionSignature : undefined
      if (
        (contractName !== undefined && typeof contractName !== 'string') ||
        (functionSignature !== undefined &&
          typeof functionSignature !== 'string')
      ) {
        return null
      }
      actions.push({
        ...normalized.actions[index]!,
        ...(normalizedContractName === undefined
          ? {}
          : { contractName: normalizedContractName }),
        ...(normalizedFunctionSignature === undefined
          ? {}
          : { functionSignature: normalizedFunctionSignature }),
      })
    }

    return {
      networkId,
      fingerprint: parsed.fingerprint,
      parentHash: parsed.parentHash,
      proposedHash: parsed.proposedHash,
      title: parsed.title,
      description: parsed.description,
      actions,
      createdAt: parsed.createdAt,
    }
  } catch {
    return null
  }
}

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
    return parseGovernancePrefill(raw, networkId, fingerprint)
  } catch {
    return null
  }
}

export const clearGovernancePrefill = (
  networkId: string,
  fingerprint: string
) => window.localStorage.removeItem(key(networkId, fingerprint))
