import { isAddress, isHex } from 'viem'

import type { GovernanceComposerActionKey } from './composer'
import {
  type TokenDisplay,
  formatBlockCount,
  formatBps,
  formatPercent18,
  formatTokenAmount,
  formatUnixSeconds,
  formatUsd8,
  formatWei,
} from './format'

/**
 * How one editable value is entered, checked, and shown. The composer renders an input per kind,
 * the same kind formats the value for reviewers, and the two never disagree about units.
 */
export type GovernanceFieldKind =
  /** An account: a checksummed address or an ENS name resolved before encoding. */
  | 'address'
  /** Token base units, entered as a decimal amount once the token's decimals are known. */
  | 'amount'
  /** A decimal ETH amount, encoded as wei. */
  | 'ether'
  /** Unix seconds, picked as a date and time. */
  | 'timestamp'
  /** A block count, entered as blocks or as a duration converted with the chain's block time. */
  | 'blocks'
  /** A decimal percentage, encoded as a `1e18`-scaled fraction. */
  | 'percent'
  /** A percentage stored as basis points. */
  | 'bps'
  /** A dollar amount stored as USD × 1e8. */
  | 'usd'
  | 'boolean'
  | 'bytes32'
  | 'bytes'
  | 'uri'
  | 'text'
  /** A decimal whole number used as-is. */
  | 'integer'
  | 'address-list'
  /** Safe operation: call or delegatecall. */
  | 'operation'
  /** The exact scoring tuple, edited by its own structured form. */
  | 'params'

/** Where a field can pull a value from instead of being typed. */
export type GovernanceFieldPicker =
  | 'safe-owner'
  | 'safe-module'
  | 'network-contract'
  | 'proposal'
  | 'score-root'
  | 'token'
  | 'role-holder'
  | 'rewards-funder'
  | 'recovery-action'

/** Live settings the composer can show beside the field they replace. */
export type GovernanceCurrentKey =
  | 'quorum'
  | 'votingDelay'
  | 'votingPeriod'
  | 'executionDelay'
  | 'rewardsPaused'
  | 'rewardsFeeRecipient'
  | 'rewardsFee'
  | 'rewardsAllowlistEnabled'
  | 'signerSyncPaused'
  | 'metadataURI'
  | 'vaultMinPaidIntervalBlocks'
  | 'vaultMaxPerRootUsd'
  | 'recoveryProposer'
  | 'safeGuard'
  | 'snapshotVerifier'
  | 'snapshotAccumulator'
  | 'snapshotAnchorRegistry'

export type GovernanceFieldSpec = {
  key: string
  label: string
  kind: GovernanceFieldKind
  /** An empty value blocks review. Optional fields encode their empty value. */
  required?: boolean
  help?: string
  placeholder?: string
  /** For `amount`: the draft key holding the token address, or fixed metadata. */
  token?: { field: string } | TokenDisplay
  /** For `timestamp`: what a zero value means when zero is permitted. */
  zeroLabel?: string
  /** For `boolean`: what each state does. */
  options?: { true: string; false: string }
  picker?: GovernanceFieldPicker
  current?: GovernanceCurrentKey
  /** Rendering hint: span the whole grid row. */
  span?: 'full'
  /** Derived or rarely edited: collapsed until opened. */
  advanced?: boolean
  /** Always shown under the field, independent of its value. */
  warning?: string
}

const address = (
  key: string,
  label: string,
  extra: Partial<GovernanceFieldSpec> = {}
): GovernanceFieldSpec => ({
  key,
  label,
  kind: 'address',
  required: true,
  placeholder: '0x… or name.eth',
  ...extra,
})

const bool = (
  key: string,
  label: string,
  options: { true: string; false: string },
  extra: Partial<GovernanceFieldSpec> = {}
): GovernanceFieldSpec => ({
  key,
  label,
  kind: 'boolean',
  required: true,
  options,
  ...extra,
})

const NO_FIELDS: readonly GovernanceFieldSpec[] = []

const governanceDelayField = (
  label: string,
  current: GovernanceCurrentKey,
  help: string
): readonly GovernanceFieldSpec[] => [
  { key: 'blocks', label, kind: 'blocks', required: true, current, help },
]

const safetyAddress = (
  label: string,
  current: GovernanceCurrentKey,
  help?: string
): readonly GovernanceFieldSpec[] => [
  address('address', label, { current, ...(help ? { help } : {}) }),
]

const FIELDS: Record<
  GovernanceComposerActionKey,
  readonly GovernanceFieldSpec[]
> = {
  'send-eth': [
    address('recipient', 'Recipient'),
    {
      key: 'amountEth',
      label: 'Amount',
      kind: 'ether',
      required: true,
      placeholder: '0.0',
    },
  ],
  'send-erc20': [
    address('token', 'Token', { picker: 'token', placeholder: '0x…' }),
    address('recipient', 'Recipient'),
    {
      key: 'amountBaseUnits',
      label: 'Amount',
      kind: 'amount',
      required: true,
      token: { field: 'token' },
    },
  ],
  'fund-rewards': [
    address('token', 'Reward token', {
      picker: 'token',
      placeholder: '0x…',
      help: 'The zero address funds rewards in ETH.',
    }),
    {
      key: 'amountBaseUnits',
      label: 'Amount',
      kind: 'amount',
      required: true,
      token: { field: 'token' },
    },
    {
      key: 'expectedRoot',
      label: 'Score root to pay against',
      kind: 'bytes32',
      required: true,
      picker: 'score-root',
      span: 'full',
      help: 'Choosing a proven root also fills in its total score.',
    },
    {
      key: 'expectedTotalMerkleValue',
      label: 'Total score under that root',
      kind: 'integer',
      required: true,
      help: 'Rewards split proportionally over this exact total.',
    },
    {
      key: 'claimDeadline',
      label: 'Claim deadline',
      kind: 'timestamp',
      required: true,
      zeroLabel: 'No expiry',
      help: 'After the deadline, unclaimed rewards can be swept back.',
    },
    {
      key: 'maxFeeAmount',
      label: 'Maximum distributor fee',
      kind: 'amount',
      required: true,
      token: { field: 'token' },
      help: 'The distribution reverts if the fee would exceed this.',
    },
    address('expectedFeeRecipient', 'Expected fee recipient', {
      current: 'rewardsFeeRecipient',
      help: 'The distribution reverts if the fee recipient changed meanwhile.',
    }),
  ],
  'set-rewards-paused': [
    bool(
      'paused',
      'Rewards',
      {
        true: 'Pause funding and claims',
        false: 'Resume funding and claims',
      },
      { current: 'rewardsPaused' }
    ),
  ],
  'set-rewards-fee-recipient': [
    address('recipient', 'New fee recipient', {
      current: 'rewardsFeeRecipient',
    }),
  ],
  'set-rewards-fee-percentage': [
    {
      key: 'feePercent',
      label: 'Fee',
      kind: 'percent',
      required: true,
      current: 'rewardsFee',
      placeholder: '2.5',
      help: 'Decreases apply immediately. Increases wait out the distributor’s delay.',
    },
  ],
  'set-rewards-allowlist-enabled': [
    bool(
      'enabled',
      'Funder allowlist',
      {
        true: 'Require allowlisted funders',
        false: 'Let anyone fund rewards',
      },
      { current: 'rewardsAllowlistEnabled' }
    ),
  ],
  'set-rewards-distributor-allowance': [
    address('distributor', 'Funder', { picker: 'rewards-funder' }),
    bool('allowed', 'Allowance', {
      true: 'Allow this funder',
      false: 'Remove this funder',
    }),
  ],
  'update-scoring-params': [
    {
      key: 'proposed',
      label: 'Scoring parameters',
      kind: 'params',
      required: true,
      span: 'full',
    },
    {
      key: 'evidenceURI',
      label: 'Evidence',
      kind: 'uri',
      placeholder: 'ipfs://…',
      help: 'Optional: a document explaining the change.',
    },
    bool(
      'syncSigner',
      'Signer selection',
      {
        true: 'Synchronize signer selection to these parameters',
        false: 'Leave signer selection unchanged',
      },
      { span: 'full' }
    ),
  ],
  'rotate-weighted-prior': [
    address('controller', 'Weighted parameters controller', {
      advanced: true,
      placeholder: '0x…',
      help: 'Filled in from this network. It must match the network’s controller.',
    }),
    {
      key: 'manifest',
      label: 'Manifest bytes',
      kind: 'bytes',
      required: true,
      span: 'full',
      help: 'Prepared in the weighted starting-shares workspace.',
    },
    {
      key: 'metadataDigest',
      label: 'Metadata digest',
      kind: 'bytes32',
      required: true,
      span: 'full',
    },
  ],
  'cancel-weighted-prior': NO_FIELDS,
  'propose-composition-policy': [
    {
      key: 'manifest',
      label: 'Policy manifest bytes',
      kind: 'bytes',
      required: true,
      span: 'full',
      help: 'Prepared in the composition workspace.',
    },
    {
      key: 'adapters',
      label: 'Source adapters',
      kind: 'address-list',
      required: true,
      span: 'full',
    },
    {
      key: 'metadataDigest',
      label: 'Metadata digest',
      kind: 'bytes32',
      required: true,
      span: 'full',
    },
  ],
  'cancel-composition-policy': NO_FIELDS,
  'update-network-profile': [
    {
      key: 'metadataURI',
      label: 'Profile metadata',
      kind: 'uri',
      required: true,
      current: 'metadataURI',
      placeholder: 'ipfs://…',
      span: 'full',
    },
    address('snapshot', 'Network snapshot', {
      advanced: true,
      required: false,
      placeholder: '0x…',
      help: 'Only set when the profile belongs to a different snapshot.',
    }),
  ],
  'set-operational-role': [
    address('account', 'Account', { picker: 'role-holder' }),
    bool('granted', 'Operational role', {
      true: 'Grant the role',
      false: 'Revoke the role',
    }),
  ],
  'propose-constitutional-transfer': [
    address('successor', 'Proposed successor', {
      span: 'full',
      warning:
        'The successor must accept on-chain. Acceptance gives it constitutional authority and removes this Safe’s authority.',
    }),
  ],
  'cancel-constitutional-transfer': NO_FIELDS,
  'set-governance-quorum': [
    {
      key: 'quorumPercent',
      label: 'Quorum',
      kind: 'percent',
      required: true,
      current: 'quorum',
      placeholder: '15',
      help: 'Share of total voting power that must vote yes or no. Abstentions do not count.',
    },
  ],
  'set-governance-voting-delay': governanceDelayField(
    'Voting delay',
    'votingDelay',
    'How long after a proposal is created before voting opens.'
  ),
  'set-governance-voting-period': governanceDelayField(
    'Voting period',
    'votingPeriod',
    'How long voting stays open.'
  ),
  'set-governance-execution-delay': governanceDelayField(
    'Execution delay',
    'executionDelay',
    'How long a passed proposal waits before it can be executed.'
  ),
  'set-governance-delegatecall-target': [
    address('target', 'Delegatecall target', { placeholder: '0x…' }),
    bool(
      'allowed',
      'Allowlist',
      {
        true: 'Allow delegatecalls to this target',
        false: 'Revoke delegatecalls to this target',
      },
      {
        warning:
          'Allowed delegatecall code runs in the Safe’s own storage and bypasses its transaction guard.',
      }
    ),
  ],
  'cancel-governance-proposal': [
    {
      key: 'proposalId',
      label: 'Proposal to cancel',
      kind: 'integer',
      required: true,
      picker: 'proposal',
      placeholder: '1',
    },
  ],
  'set-signer-sync-paused': [
    bool(
      'paused',
      'Signer synchronization',
      {
        true: 'Pause new signer proofs',
        false: 'Resume signer proofs',
      },
      { current: 'signerSyncPaused' }
    ),
  ],
  'set-snapshot-verifier': safetyAddress(
    'New proof verifier',
    'snapshotVerifier'
  ),
  'set-snapshot-accumulator': safetyAddress(
    'New attestation accumulator',
    'snapshotAccumulator'
  ),
  'set-snapshot-anchor-registry': safetyAddress(
    'New anchor registry',
    'snapshotAnchorRegistry'
  ),
  'enable-safe-module': [
    address('address', 'Module to enable', {
      placeholder: '0x…',
      help: 'An enabled module can execute transactions from the Safe without signatures.',
    }),
  ],
  'disable-safe-module': [
    address('module', 'Module to disable', { picker: 'safe-module' }),
    address('previousModule', 'Previous module in the Safe’s list', {
      advanced: true,
      placeholder: '0x…',
      help: 'Derived from the Safe’s module list when the module is chosen above.',
    }),
  ],
  'set-safe-guard': safetyAddress(
    'New transaction guard',
    'safeGuard',
    'The zero address removes the guard.'
  ),
  'swap-safe-owner': [
    address('oldOwner', 'Owner to replace', { picker: 'safe-owner' }),
    address('newOwner', 'New owner'),
    address('previousOwner', 'Previous owner in the Safe’s list', {
      advanced: true,
      placeholder: '0x…',
      help: 'Derived from the Safe’s owner list when the owner is chosen above.',
    }),
  ],
  'set-recovery-proposer': safetyAddress(
    'New recovery proposer',
    'recoveryProposer'
  ),
  'cancel-recovery-action': [
    {
      key: 'actionId',
      label: 'Queued recovery action',
      kind: 'bytes32',
      required: true,
      picker: 'recovery-action',
      span: 'full',
    },
  ],
  'set-vault-policy': [
    {
      key: 'minPaidIntervalBlocks',
      label: 'Minimum time between paid roots',
      kind: 'blocks',
      required: true,
      current: 'vaultMinPaidIntervalBlocks',
    },
    {
      key: 'maxPerRootUsd',
      label: 'Maximum payout per root',
      kind: 'usd',
      required: true,
      current: 'vaultMaxPerRootUsd',
    },
  ],
  'request-vault-withdrawal': [
    {
      key: 'ethAmount',
      label: 'ETH to withdraw',
      kind: 'amount',
      required: true,
      token: { decimals: 18, symbol: 'ETH' },
    },
    {
      key: 'usdcAmount',
      label: 'USDC to withdraw',
      kind: 'amount',
      required: true,
      token: { decimals: 6, symbol: 'USDC' },
    },
  ],
  'cancel-vault-withdrawal': NO_FIELDS,
  'execute-vault-withdrawal': [
    address('recipient', 'Withdrawal recipient', { span: 'full' }),
  ],
  'create-contribution-round': [
    {
      key: 'name',
      label: 'Round name',
      kind: 'text',
      required: true,
      span: 'full',
    },
    {
      key: 'roundStart',
      label: 'Opens',
      kind: 'timestamp',
      required: true,
    },
    { key: 'roundEnd', label: 'Closes', kind: 'timestamp', required: true },
    {
      key: 'totalPool',
      label: 'Pool shares',
      kind: 'integer',
      required: true,
      help: 'Proportional shares the pool splits over, not a token amount.',
    },
    {
      key: 'evaluatorCarveoutBps',
      label: 'Rater reward',
      kind: 'bps',
      required: true,
      help: 'Share of the pool reserved for people who rate contributions.',
    },
    address('distributorToken', 'Payout token', {
      picker: 'token',
      placeholder: '0x…',
      help: 'The zero address means ETH.',
    }),
    {
      key: 'salt',
      label: 'Salt',
      kind: 'bytes32',
      required: true,
      advanced: true,
      help: 'Generated randomly; it makes the round’s address unique.',
    },
  ],
  custom: [
    address('target', 'Target contract', {
      picker: 'network-contract',
      placeholder: '0x…',
    }),
    {
      key: 'valueEth',
      label: 'ETH to send',
      kind: 'ether',
      required: true,
      placeholder: '0',
    },
    {
      key: 'operation',
      label: 'Operation',
      kind: 'operation',
      required: true,
    },
    {
      key: 'description',
      label: 'What this call does',
      kind: 'text',
      required: true,
      span: 'full',
    },
    {
      key: 'data',
      label: 'Calldata',
      kind: 'bytes',
      required: true,
      span: 'full',
    },
  ],
}

export const governanceActionFields = (
  key: GovernanceComposerActionKey
): readonly GovernanceFieldSpec[] => FIELDS[key]

export const governanceActionField = (
  key: GovernanceComposerActionKey,
  field: string
): GovernanceFieldSpec | undefined =>
  FIELDS[key].find((spec) => spec.key === field)

const DECIMAL = /^\d+(?:\.\d+)?$/
const DIGITS = /^(0|[1-9]\d*)$/

const isBytes32 = (value: string) =>
  value.length === 66 && isHex(value, { strict: true })

const isByteAligned = (value: string) =>
  isHex(value, { strict: true }) && value.length % 2 === 0

const ENS_LIKE = /^[^\s]+\.[a-z]{2,}$/i

const stringOf = (value: unknown) => (typeof value === 'string' ? value : '')

/**
 * Check one value the way the field will be encoded, before any network work. Returns a message
 * for the person or null. Empty optional values pass; empty required values fail.
 */
export const validateGovernanceFieldValue = (
  spec: GovernanceFieldSpec,
  value: unknown
): string | null => {
  switch (spec.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'Choose one option.'
    case 'operation':
      return value === 0 || value === 1 ? null : 'Choose call or delegatecall.'
    case 'params':
      return value && typeof value === 'object' && !Array.isArray(value)
        ? null
        : 'Complete the scoring parameters.'
    case 'address-list': {
      if (!Array.isArray(value)) return 'Add at least one address.'
      if (spec.required && value.length === 0)
        return 'Add at least one address.'
      const bad = value.findIndex(
        (entry) => typeof entry !== 'string' || !isAddress(entry)
      )
      return bad === -1 ? null : `Entry ${bad + 1} is not a valid address.`
    }
    default:
      break
  }
  const text = stringOf(value).trim()
  if (!text) return spec.required ? 'Required.' : null
  switch (spec.kind) {
    case 'address':
      return isAddress(text) || ENS_LIKE.test(text)
        ? null
        : 'Enter a valid address or ENS name.'
    case 'amount':
    case 'integer':
    case 'blocks':
    case 'bps':
    case 'usd':
    case 'timestamp':
      return DIGITS.test(text) ? null : 'Enter a whole number.'
    case 'ether':
      return DECIMAL.test(text) ? null : 'Enter a decimal amount.'
    case 'percent': {
      if (!DECIMAL.test(text)) return 'Enter a percentage.'
      const [integer = '0', fraction = ''] = text.split('.')
      if (fraction.length > PERCENT_INPUT_DECIMALS)
        return `Use at most ${PERCENT_INPUT_DECIMALS} decimal places.`
      return Number(integer) > 100 ||
        (integer === '100' && /[1-9]/.test(fraction))
        ? 'A percentage cannot exceed 100.'
        : null
    }
    case 'bytes32':
      return isBytes32(text) ? null : 'Enter 32 bytes of hex (66 characters).'
    case 'bytes':
      return isByteAligned(text)
        ? null
        : 'Enter byte-aligned hex starting with 0x.'
    case 'uri':
      return /^[a-z][a-z0-9+.-]*:/i.test(text)
        ? null
        : 'Use a full URI such as ipfs://… or https://….'
    case 'text':
      return null
    default:
      return null
  }
}

/** The on-chain fraction has 18 decimals, so a percentage keeps at most 16. */
export const PERCENT_INPUT_DECIMALS = 16

/**
 * Every field-level problem in a draft, keyed by field. Structured editors validate their own
 * composite value; this covers what the schema knows.
 */
export const validateGovernanceActionDraft = (
  key: GovernanceComposerActionKey,
  values: unknown
): Record<string, string> => {
  const record =
    values && typeof values === 'object' && !Array.isArray(values)
      ? (values as Record<string, unknown>)
      : {}
  const errors: Record<string, string> = {}
  for (const spec of FIELDS[key]) {
    const message = validateGovernanceFieldValue(spec, record[spec.key])
    if (message) errors[spec.key] = message
  }
  return errors
}

export type GovernanceFieldFormatContext = {
  /** Verified metadata per lowercase token address. */
  tokens?: (token: string) => TokenDisplay | undefined
  blockTimeSeconds?: number
  now?: number
}

/**
 * The value as reviewers should read it, from the same canonical string the encoder consumes.
 * Falls back to the raw value when it cannot be interpreted, never to nothing.
 */
export const formatGovernanceFieldValue = (
  spec: GovernanceFieldSpec,
  value: unknown,
  values: Record<string, unknown> = {},
  context: GovernanceFieldFormatContext = {}
): string => {
  if (spec.kind === 'boolean') {
    return value === true
      ? (spec.options?.true ?? 'Yes')
      : value === false
        ? (spec.options?.false ?? 'No')
        : ''
  }
  if (spec.kind === 'operation') return value === 1 ? 'Delegatecall' : 'Call'
  if (spec.kind === 'address-list') {
    return Array.isArray(value)
      ? `${value.length} ${value.length === 1 ? 'address' : 'addresses'}`
      : ''
  }
  if (spec.kind === 'params') return value ? 'Scoring parameters' : ''
  const text = stringOf(value).trim()
  if (!text) return ''
  switch (spec.kind) {
    case 'amount': {
      const tokenSpec = spec.token
      const token = !tokenSpec
        ? undefined
        : 'field' in tokenSpec
          ? context.tokens?.(stringOf(values[tokenSpec.field]))
          : tokenSpec
      return formatTokenAmount(text, token)
    }
    case 'ether':
      return `${text} ETH`
    case 'timestamp':
      return formatUnixSeconds(text, {
        ...(spec.zeroLabel ? { zeroLabel: spec.zeroLabel } : {}),
        ...(context.now !== undefined ? { now: context.now } : {}),
      })
    case 'blocks':
      return formatBlockCount(text, context.blockTimeSeconds)
    case 'percent':
      return `${text}%`
    case 'bps':
      return formatBps(text)
    case 'usd':
      return formatUsd8(text)
    default:
      return text
  }
}

/** Convenience for encoded values that arrive as wei rather than a decimal ETH string. */
export const formatEncodedWei = formatWei
export const formatEncodedPercent = formatPercent18
