import { type Hex, formatEther, isHex } from 'viem'

import {
  type GovernanceActionDraft,
  isGovernanceComposerActionKey,
  normalizeSafeActions,
} from './actions'

export type GovernancePrefillAction = GovernanceActionDraft

export type GovernancePrefill = {
  version: 2
  networkId: string
  fingerprint: Hex
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

/** Ensure the value can cross localStorage without bigint coercion or lossy object types. */
const jsonValue = (value: unknown, depth = 0): boolean => {
  if (depth > 20) return false
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    return value.every((entry) => jsonValue(entry, depth + 1))
  }
  const candidate = record(value)
  return (
    !!candidate &&
    Object.values(candidate).every((entry) => jsonValue(entry, depth + 1))
  )
}

const sharedFields = (
  parsed: Record<string, unknown>,
  networkId: string,
  fingerprint: string
) =>
  parsed.networkId === networkId &&
  parsed.fingerprint === fingerprint &&
  bytes32(parsed.fingerprint) &&
  typeof parsed.title === 'string' &&
  typeof parsed.description === 'string' &&
  typeof parsed.createdAt === 'number' &&
  Number.isFinite(parsed.createdAt) &&
  parsed.createdAt >= 0 &&
  Array.isArray(parsed.actions)

const parseV2Actions = (value: unknown[]): GovernancePrefillAction[] | null => {
  const actions: GovernancePrefillAction[] = []
  for (const entry of value) {
    const action = record(entry)
    if (
      !action ||
      typeof action.actionKey !== 'string' ||
      !isGovernanceComposerActionKey(action.actionKey) ||
      !Object.prototype.hasOwnProperty.call(action, 'values') ||
      !jsonValue(action.values)
    ) {
      return null
    }
    actions.push({ actionKey: action.actionKey, values: action.values })
  }
  return actions
}

/** Keep drafts created before v2 usable by opening each exact tuple as an editable custom call. */
const migrateLegacyActions = (
  value: unknown
): GovernancePrefillAction[] | null => {
  const normalized = normalizeSafeActions(value)
  if (!normalized.ok) return null
  return normalized.actions.map((action) => ({
    actionKey: 'custom',
    values: {
      target: action.target,
      valueEth: formatEther(BigInt(action.value)),
      data: action.data,
      operation: action.operation,
      description: action.description ?? '',
    },
  }))
}

/** Parse the local-storage boundary without trusting a TypeScript assertion over JSON. */
export const parseGovernancePrefill = (
  raw: string,
  networkId: string,
  fingerprint: string
): GovernancePrefill | null => {
  try {
    const parsed = record(JSON.parse(raw))
    if (!parsed || !sharedFields(parsed, networkId, fingerprint)) return null

    if (parsed.version === 2) {
      const actions = parseV2Actions(parsed.actions as unknown[])
      if (!actions) return null
      return {
        version: 2,
        networkId,
        fingerprint: parsed.fingerprint as Hex,
        title: parsed.title as string,
        description: parsed.description as string,
        actions,
        createdAt: parsed.createdAt as number,
      }
    }

    // v1 carried scoring-only hashes plus frozen Safe tuples. Validate its complete boundary
    // before migrating so malformed historical localStorage cannot enter the composer.
    if (parsed.version !== undefined && parsed.version !== 1) return null
    if (!bytes32(parsed.parentHash) || !bytes32(parsed.proposedHash))
      return null
    const actions = migrateLegacyActions(parsed.actions)
    if (!actions) return null
    return {
      version: 2,
      networkId,
      fingerprint: parsed.fingerprint as Hex,
      title: parsed.title as string,
      description: parsed.description as string,
      actions,
      createdAt: parsed.createdAt as number,
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
