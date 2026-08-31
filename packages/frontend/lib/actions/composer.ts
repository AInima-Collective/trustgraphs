import {
  type Address,
  type Hex,
  formatEther,
  isAddress,
  isHex,
  parseEther,
  parseUnits,
  zeroAddress,
} from 'viem'

import type { ExactParamsJson } from '../scoring-params'
import { paramsFromJson } from '../scoring-params'
import { customAction } from './custom'
import {
  governanceCancelProposalAction,
  governanceDelegateCallTargetAction,
  governanceExecutionDelayAction,
  governanceQuorumAction,
  governanceVotingDelayAction,
  governanceVotingPeriodAction,
} from './governance'
import {
  cancelConstitutionalTransferAction,
  constitutionalTransferAction,
  operationalRoleAction,
} from './membership'
import { networkProfileAction } from './profile'
import { signerPauseAction } from './safety'
import { scoringParamsAction } from './scoring'
import { ethTransferAction } from './transfer'
import {
  erc20TransferAction,
  rewardDistributionAction,
  rewardsAllowlistAction,
  rewardsDistributorAllowanceAction,
  rewardsFeePercentageAction,
  rewardsFeeRecipientAction,
  rewardsPauseAction,
} from './treasury'
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
    danger: false,
  },
  {
    key: 'send-erc20',
    category: 'treasury',
    label: 'Send ERC-20',
    summary: 'Transfer token base units from the network Safe.',
    danger: false,
  },
  {
    key: 'fund-rewards',
    category: 'treasury',
    label: 'Fund network rewards',
    summary: 'Fund a distribution against an exact proven score root.',
    danger: false,
  },
  {
    key: 'set-rewards-paused',
    category: 'treasury',
    label: 'Pause or resume rewards',
    summary: 'Control new reward funding and claims.',
    danger: false,
  },
  {
    key: 'set-rewards-fee-recipient',
    category: 'treasury',
    label: 'Set rewards fee recipient',
    summary: 'Choose where distributor fees are paid.',
    danger: false,
  },
  {
    key: 'set-rewards-fee-percentage',
    category: 'treasury',
    label: 'Set rewards fee',
    summary: 'Set or schedule the distributor fee percentage.',
    danger: false,
  },
  {
    key: 'set-rewards-allowlist-enabled',
    category: 'treasury',
    label: 'Enable or disable rewards allowlist',
    summary: 'Require reward funders to be individually allowlisted.',
    danger: false,
  },
  {
    key: 'set-rewards-distributor-allowance',
    category: 'treasury',
    label: 'Update rewards funder allowance',
    summary: 'Allow or remove one address from funding rewards.',
    danger: false,
  },
  {
    key: 'update-scoring-params',
    category: 'scoring',
    label: 'Update scoring parameters',
    summary: 'Publish a versioned scoring configuration.',
    danger: false,
  },
  {
    key: 'rotate-weighted-prior',
    category: 'scoring',
    label: 'Change weighted starting shares',
    summary: 'Propose a weighted-prior manifest for delayed activation.',
    danger: false,
  },
  {
    key: 'update-network-profile',
    category: 'network',
    label: 'Update network profile',
    summary: 'Publish a new metadata URI for this network.',
    danger: false,
  },
  {
    key: 'set-operational-role',
    category: 'membership',
    label: 'Grant or revoke operational role',
    summary: 'Change who may publish operational parameters.',
    danger: false,
  },
  {
    key: 'propose-constitutional-transfer',
    category: 'membership',
    label: 'Propose constitutional transfer',
    summary: 'Begin a two-step handoff of constitutional authority.',
    danger: true,
  },
  {
    key: 'cancel-constitutional-transfer',
    category: 'membership',
    label: 'Cancel constitutional transfer',
    summary: 'Stop the currently pending constitutional handoff.',
    danger: true,
  },
  {
    key: 'set-governance-quorum',
    category: 'governance',
    label: 'Set governance quorum',
    summary: 'Set the decisive voting power required for proposals.',
    danger: false,
  },
  {
    key: 'set-governance-voting-delay',
    category: 'governance',
    label: 'Set voting delay',
    summary: 'Set how many blocks pass before voting opens.',
    danger: false,
  },
  {
    key: 'set-governance-voting-period',
    category: 'governance',
    label: 'Set voting period',
    summary: 'Set how many blocks voting remains open.',
    danger: false,
  },
  {
    key: 'set-governance-execution-delay',
    category: 'governance',
    label: 'Set execution delay',
    summary: 'Set how many blocks passed proposals wait before execution.',
    danger: false,
  },
  {
    key: 'set-governance-delegatecall-target',
    category: 'governance',
    label: 'Update delegatecall allowlist',
    summary: 'Allow or revoke one delegatecall target for proposals.',
    danger: true,
  },
  {
    key: 'cancel-governance-proposal',
    category: 'governance',
    label: 'Cancel a proposal',
    summary: 'Cancel one existing, unexecuted governance proposal.',
    danger: true,
  },
  {
    key: 'set-signer-sync-paused',
    category: 'safety',
    label: 'Pause or resume signer sync',
    summary: 'Control whether new signer proofs may be applied.',
    danger: false,
  },
  {
    key: 'custom',
    category: 'custom',
    label: 'Custom contract call',
    summary: 'Execute raw calldata when no typed action exists.',
    danger: false,
  },
] as const satisfies readonly {
  key: string
  category: GovernanceActionCategory
  label: string
  summary: string
  danger: boolean
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
    case 'fund-rewards':
    case 'set-rewards-paused':
    case 'set-rewards-fee-recipient':
    case 'set-rewards-fee-percentage':
    case 'set-rewards-allowlist-enabled':
    case 'set-rewards-distributor-allowance':
      return !!context.fundDistributor
    case 'set-governance-quorum':
    case 'set-governance-voting-delay':
    case 'set-governance-voting-period':
    case 'set-governance-execution-delay':
    case 'set-governance-delegatecall-target':
    case 'cancel-governance-proposal':
      return !!context.governanceModule
    case 'set-operational-role':
    case 'propose-constitutional-transfer':
    case 'cancel-constitutional-transfer':
      return !!context.snapshot
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
    case 'send-erc20':
      return { token: '', recipient: '', amountBaseUnits: '' }
    case 'fund-rewards':
      return {
        token: zeroAddress,
        amountBaseUnits: '',
        expectedRoot: '',
        expectedTotalMerkleValue: '',
        claimDeadline: '0',
        maxFeeAmount: '0',
        expectedFeeRecipient: '',
      }
    case 'set-rewards-paused':
      return { paused: true }
    case 'set-rewards-fee-recipient':
      return { recipient: '' }
    case 'set-rewards-fee-percentage':
      return { feePercent: '' }
    case 'set-rewards-allowlist-enabled':
      return { enabled: true }
    case 'set-rewards-distributor-allowance':
      return { distributor: '', allowed: true }
    case 'update-scoring-params':
      return { proposed: null, evidenceURI: '', syncSigner: false }
    case 'rotate-weighted-prior':
      return { controller: '', manifest: '0x', metadataDigest: '' }
    case 'update-network-profile':
      return { metadataURI: '' }
    case 'set-operational-role':
      return { account: '', granted: true }
    case 'propose-constitutional-transfer':
      return { successor: '' }
    case 'cancel-constitutional-transfer':
      return {}
    case 'set-governance-quorum':
      return { quorumPercent: '' }
    case 'set-governance-voting-delay':
    case 'set-governance-voting-period':
    case 'set-governance-execution-delay':
      return { blocks: '' }
    case 'set-governance-delegatecall-target':
      return { target: '', allowed: true }
    case 'cancel-governance-proposal':
      return { proposalId: '' }
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

const addressValue = (
  values: Record<string, unknown>,
  key: string,
  label: string
) => {
  const value = stringValue(values, key).trim()
  if (!isAddress(value)) throw new Error(`${label} must be a valid address`)
  return value
}

const booleanValue = (values: Record<string, unknown>, key: string) => {
  const value = values[key]
  if (typeof value !== 'boolean')
    throw new Error(`${key} must be true or false`)
  return value
}

const percentageFraction = (input: string, label: string) => {
  try {
    return parseUnits(input, 16).toString()
  } catch {
    throw new Error(`${label} must be a percentage with at most 16 decimals`)
  }
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
    case 'send-erc20':
      return erc20TransferAction.encode(
        {
          token: addressValue(values, 'token', 'Token contract'),
          recipient: addressValue(values, 'recipient', 'Token recipient'),
          amount: stringValue(values, 'amountBaseUnits').trim(),
        },
        context
      )
    case 'fund-rewards': {
      const expectedRoot = stringValue(values, 'expectedRoot').trim()
      if (
        expectedRoot.length !== 66 ||
        !isHex(expectedRoot, { strict: true })
      ) {
        throw new Error('Expected score root must be 32-byte hex')
      }
      return rewardDistributionAction.encode(
        {
          token: addressValue(values, 'token', 'Reward token'),
          amount: stringValue(values, 'amountBaseUnits').trim(),
          expectedRoot: expectedRoot as Hex,
          expectedTotalMerkleValue: stringValue(
            values,
            'expectedTotalMerkleValue'
          ).trim(),
          claimDeadline: stringValue(values, 'claimDeadline').trim(),
          maxFeeAmount: stringValue(values, 'maxFeeAmount').trim(),
          expectedFeeRecipient: addressValue(
            values,
            'expectedFeeRecipient',
            'Expected fee recipient'
          ),
        },
        context
      )
    }
    case 'set-rewards-paused':
      return rewardsPauseAction.encode(
        { paused: booleanValue(values, 'paused') },
        context
      )
    case 'set-rewards-fee-recipient':
      return rewardsFeeRecipientAction.encode(
        {
          recipient: addressValue(values, 'recipient', 'Fee recipient'),
        },
        context
      )
    case 'set-rewards-fee-percentage':
      return rewardsFeePercentageAction.encode(
        {
          feePercentage: percentageFraction(
            stringValue(values, 'feePercent').trim(),
            'Fee'
          ),
        },
        context
      )
    case 'set-rewards-allowlist-enabled':
      return rewardsAllowlistAction.encode(
        { enabled: booleanValue(values, 'enabled') },
        context
      )
    case 'set-rewards-distributor-allowance':
      return rewardsDistributorAllowanceAction.encode(
        {
          distributor: addressValue(values, 'distributor', 'Rewards funder'),
          allowed: booleanValue(values, 'allowed'),
        },
        context
      )
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
    case 'set-operational-role':
      return operationalRoleAction.encode(
        {
          account: addressValue(values, 'account', 'Operational account'),
          granted: booleanValue(values, 'granted'),
        },
        context
      )
    case 'propose-constitutional-transfer':
      return constitutionalTransferAction.encode(
        { successor: addressValue(values, 'successor', 'Successor') },
        context
      )
    case 'cancel-constitutional-transfer':
      return cancelConstitutionalTransferAction.encode({}, context)
    case 'set-governance-quorum':
      return governanceQuorumAction.encode(
        {
          quorum: percentageFraction(
            stringValue(values, 'quorumPercent').trim(),
            'Quorum'
          ),
        },
        context
      )
    case 'set-governance-voting-delay':
      return governanceVotingDelayAction.encode(
        { blocks: stringValue(values, 'blocks').trim() },
        context
      )
    case 'set-governance-voting-period':
      return governanceVotingPeriodAction.encode(
        { blocks: stringValue(values, 'blocks').trim() },
        context
      )
    case 'set-governance-execution-delay':
      return governanceExecutionDelayAction.encode(
        { blocks: stringValue(values, 'blocks').trim() },
        context
      )
    case 'set-governance-delegatecall-target':
      return governanceDelegateCallTargetAction.encode(
        {
          target: addressValue(values, 'target', 'Delegatecall target'),
          allowed: booleanValue(values, 'allowed'),
        },
        context
      )
    case 'cancel-governance-proposal':
      return governanceCancelProposalAction.encode(
        { proposalId: stringValue(values, 'proposalId').trim() },
        context
      )
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
