import { type Address, formatEther, isAddress, isHex, parseEther } from 'viem'

import type { ExactParamsJson } from '../scoring-params'
import { paramsFromJson } from '../scoring-params'
import { customAction } from './custom'
import { networkProfileAction } from './profile'
import { signerPauseAction } from './safety'
import { scoringParamsAction } from './scoring'
import { ethTransferAction } from './transfer'
import type {
  GovernanceActionCategory,
  GovernanceActionContext,
  SafeAction,
  SafeOperation,
} from './types'
import { weightedPriorRotationAction } from './weighted'

export const governanceComposerRegistry = [
  {
    key: 'send-eth',
    category: 'treasury',
    label: 'Send ETH',
    summary: 'Transfer ETH from the network Safe.',
  },
  {
    key: 'update-scoring-params',
    category: 'scoring',
    label: 'Update scoring parameters',
    summary: 'Publish a versioned scoring configuration.',
  },
  {
    key: 'rotate-weighted-prior',
    category: 'scoring',
    label: 'Change weighted starting shares',
    summary: 'Propose a weighted-prior manifest for delayed activation.',
  },
  {
    key: 'update-network-profile',
    category: 'network',
    label: 'Update network profile',
    summary: 'Publish a new metadata URI for this network.',
  },
  {
    key: 'set-signer-sync-paused',
    category: 'safety',
    label: 'Pause or resume signer sync',
    summary: 'Control whether new signer proofs may be applied.',
  },
  {
    key: 'custom',
    category: 'custom',
    label: 'Custom contract call',
    summary: 'Execute raw calldata when no typed action exists.',
  },
] as const satisfies readonly {
  key: string
  category: GovernanceActionCategory
  label: string
  summary: string
}[]

export type GovernanceComposerActionKey =
  (typeof governanceComposerRegistry)[number]['key']

export type GovernanceActionDraft = {
  actionKey: GovernanceComposerActionKey
  values: unknown
}

export const isGovernanceComposerActionKey = (
  value: string
): value is GovernanceComposerActionKey =>
  governanceComposerRegistry.some((definition) => definition.key === value)

export const governanceComposerDefinition = (key: string) =>
  governanceComposerRegistry.find((definition) => definition.key === key)

export const governanceComposerActionAvailable = (
  key: GovernanceComposerActionKey,
  context: GovernanceActionContext
) => {
  switch (key) {
    case 'update-scoring-params':
      return !!context.paramsController
    case 'update-network-profile':
      return !!context.snapshot
    case 'set-signer-sync-paused':
      return !!context.signerSyncModule
    case 'rotate-weighted-prior':
      return !!context.weightedParamsController
    default:
      return true
  }
}

export const defaultGovernanceActionValues = (
  key: GovernanceComposerActionKey
): unknown => {
  switch (key) {
    case 'send-eth':
      return { recipient: '', amountEth: '' }
    case 'update-scoring-params':
      return { proposed: null, evidenceURI: '', syncSigner: false }
    case 'rotate-weighted-prior':
      return { controller: '', manifest: '0x', metadataDigest: '' }
    case 'update-network-profile':
      return { metadataURI: '' }
    case 'set-signer-sync-paused':
      return { paused: true }
    case 'custom':
      return {
        target: '',
        valueEth: '0',
        data: '0x',
        operation: 0,
        description: '',
      }
  }
}

type RecipientResolver = (
  identifier: string,
  previewAddress?: Address | null
) => Promise<{ address: Address; ensName?: string | null }>

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Action values are malformed')
  }
  return value as Record<string, unknown>
}

const stringValue = (values: Record<string, unknown>, key: string) => {
  const value = values[key]
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

const etherValue = (input: string, label: string, allowZero = false) => {
  let value: bigint
  try {
    value = parseEther(input || '0')
  } catch {
    throw new Error(`${label} must be a decimal ETH amount`)
  }
  if (value < 0n || (!allowZero && value === 0n)) {
    throw new Error(
      `${label} must be ${allowZero ? 'zero or more' : 'more than zero'}`
    )
  }
  return value
}

/** Encode one editable, JSON-safe draft through the same typed actions used by the viewer. */
export const encodeGovernanceActionDraft = async (
  draft: GovernanceActionDraft,
  context: GovernanceActionContext,
  resolveRecipient?: RecipientResolver
): Promise<SafeAction[]> => {
  const values = record(draft.values)
  switch (draft.actionKey) {
    case 'send-eth': {
      const identifier = stringValue(values, 'recipient').trim()
      const wei = etherValue(stringValue(values, 'amountEth'), 'ETH amount')
      const previewAddress =
        typeof values.previewAddress === 'string' &&
        isAddress(values.previewAddress)
          ? values.previewAddress
          : undefined
      let recipient: Address
      let ensName: string | undefined
      if (isAddress(identifier)) {
        recipient = identifier
      } else if (resolveRecipient) {
        const resolved = await resolveRecipient(identifier, previewAddress)
        recipient = resolved.address
        ensName = resolved.ensName ?? undefined
      } else {
        throw new Error(
          'Recipient must be a valid address or resolved ENS name'
        )
      }
      return ethTransferAction.encode(
        {
          recipient,
          value: wei.toString(),
          description: `Send ${formatEther(wei)} ETH to ${ensName ? `${ensName} (${recipient})` : recipient}`,
        },
        context
      )
    }
    case 'update-scoring-params': {
      if (!values.proposed || typeof values.proposed !== 'object') {
        throw new Error('Proposed scoring parameters are required')
      }
      if (typeof values.syncSigner !== 'boolean') {
        throw new Error('Signer synchronization choice is required')
      }
      return scoringParamsAction.encode(
        {
          proposed: paramsFromJson(values.proposed as ExactParamsJson),
          evidenceURI: stringValue(values, 'evidenceURI'),
          syncSigner: values.syncSigner,
        },
        context
      )
    }
    case 'update-network-profile': {
      const snapshot = values.snapshot
      if (
        snapshot !== undefined &&
        (typeof snapshot !== 'string' || !isAddress(snapshot))
      ) {
        throw new Error('Network snapshot must be a valid address')
      }
      const snapshotAddress =
        typeof snapshot === 'string' && isAddress(snapshot)
          ? snapshot
          : undefined
      return networkProfileAction.encode(
        {
          ...(snapshotAddress ? { snapshot: snapshotAddress } : {}),
          metadataURI: stringValue(values, 'metadataURI'),
        },
        snapshotAddress ? { ...context, snapshot: snapshotAddress } : context
      )
    }
    case 'set-signer-sync-paused': {
      if (typeof values.paused !== 'boolean') {
        throw new Error('Paused state must be true or false')
      }
      return signerPauseAction.encode({ paused: values.paused }, context)
    }
    case 'rotate-weighted-prior': {
      const controller = stringValue(values, 'controller')
      const manifest = stringValue(values, 'manifest')
      const metadataDigest = stringValue(values, 'metadataDigest')
      if (!isAddress(controller)) {
        throw new Error(
          'Weighted parameters controller must be a valid address'
        )
      }
      if (!isHex(manifest, { strict: true }) || manifest.length % 2) {
        throw new Error('Weighted manifest must be valid byte-aligned hex')
      }
      if (
        metadataDigest.length !== 66 ||
        !isHex(metadataDigest, { strict: true })
      ) {
        throw new Error('Weighted metadata digest must be 32-byte hex')
      }
      return weightedPriorRotationAction.encode(
        { controller, manifest, metadataDigest },
        { ...context, weightedParamsController: controller }
      )
    }
    case 'custom': {
      const target = stringValue(values, 'target')
      const data = stringValue(values, 'data') || '0x'
      const description = stringValue(values, 'description').trim()
      const operation = values.operation
      if (!isAddress(target)) throw new Error('Target must be a valid address')
      if (!description) throw new Error('Custom call description is required')
      if (!isHex(data, { strict: true }) || data.length % 2) {
        throw new Error('Calldata must be valid byte-aligned hex')
      }
      if (operation !== 0 && operation !== 1) {
        throw new Error('Operation must be Call or DelegateCall')
      }
      const wei = etherValue(stringValue(values, 'valueEth'), 'ETH value', true)
      return customAction.encode(
        {
          target,
          value: wei.toString(),
          data,
          operation: operation as SafeOperation,
          description,
        },
        context
      )
    }
  }
}
