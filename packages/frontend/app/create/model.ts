import { Hex, isAddress, isHex, zeroAddress } from 'viem'

import {
  CHAIN,
  CONTRACT_CONFIG,
  FAST_FACTORY_CONFIG,
  SIGNER_SYNC_CONFIG,
} from '@/lib/config'
import { parseAccountIdentifier } from '@/lib/ens'
import {
  DEFAULT_MAX_PER_ROOT_USD,
  initialPolicyProblem,
} from '@/lib/proving-prepay'
import { FULL_SEED_TRUST_SHARE_PCT } from '@/lib/trust-share'

/**
 * The data model behind the create-a-network wizard, plus the translation from the plain-language
 * choices the screens present into the exact struct `TrustgraphsFactory.createInstance` expects.
 *
 * Two rules hold everywhere in here:
 *   - the settings the guest is proven over and the settings that identify an instance are NOT
 *     choices (see `FIXED_PARAMS`): the factory rejects anything else, so the wizard never offers
 *     them;
 *   - the numbers a person sees are percentages and plain counts. The fixed-point conversion
 *     happens here, once.
 */

/**
 * The wizard prefers the fast (EPOCH_FLOOR = 1) factory generation, and only as a whole pair:
 * mixing generations would read the floor from one factory and create through a wrapper that
 * enforces another. Every flow outside this wizard keeps using the original generation, whose
 * factories remain the parents of the already-created networks.
 */
const FAST_FACTORY = (FAST_FACTORY_CONFIG?.factory || '') as Hex
const FAST_GOVERNED_FACTORY = (FAST_FACTORY_CONFIG?.governedFactory ||
  '') as Hex
const USE_FAST_GENERATION =
  FAST_FACTORY.length === 42 && FAST_GOVERNED_FACTORY.length === 42

/** The factory address for this chain, or empty when no factory is deployed here. */
export const FACTORY_ADDRESS = (
  USE_FAST_GENERATION ? FAST_FACTORY : CONTRACT_CONFIG.TrustgraphsFactory || ''
) as Hex
/** Governed wrapper used by the wizard; absent means this deployment cannot safely create DAOs. */
export const GOVERNED_FACTORY_ADDRESS = (
  USE_FAST_GENERATION
    ? FAST_GOVERNED_FACTORY
    : CONTRACT_CONFIG.GovernedTrustgraphsFactory || ''
) as Hex

export const isFactoryAvailable = () =>
  FACTORY_ADDRESS.length === 42 && GOVERNED_FACTORY_ADDRESS.length === 42

/** Devnets mine on demand, so "about once a month" is meaningless there. */
export const IS_LOCAL_CHAIN = CHAIN === 'local'

/** Matches `TrustgraphsFactory.MAX_NAME_BYTES` / `MAX_TRUSTED_SEEDS`. */
export const MAX_NAME_BYTES = 64
export const MAX_SEEDS = 64
/** Frozen proving boundary shared by InputCapacity and EasOffchainAnchorRegistry. */
export const MAX_OFFCHAIN_TOTAL_INPUTS = 200_000

const configuredRelayerText =
  process.env.NEXT_PUBLIC_EAS_OFFCHAIN_RELAYER_ADDRESSES ?? ''

/** Public addresses granted the initial registry ANCHORER_ROLE at hybrid creation. */
export const OFFCHAIN_INITIAL_RELAYERS = Array.from(
  new Set(
    configuredRelayerText
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(
        (value) => isAddress(value, { strict: false }) && value !== zeroAddress
      )
  )
) as Hex[]

export const isOffchainVouchCreationAvailable = (): boolean =>
  OFFCHAIN_INITIAL_RELAYERS.length >= 2 &&
  OFFCHAIN_INITIAL_RELAYERS.length <= 16

/**
 * The wizard's steps, by name rather than position. Everything that used to hardcode a step index
 * (the chips, the per-step gate, the pinning side effect, the review screen's edit links) keys off
 * these ids, so inserting or reordering a step is a change here and nowhere else.
 */
export const WIZARD_STEPS = [
  { id: 'description', label: 'Description' },
  { id: 'accounts', label: 'Starting accounts' },
  { id: 'scoring', label: 'Scoring' },
  { id: 'extras', label: 'Extras' },
  { id: 'review', label: 'Review' },
] as const

export type WizardStepId = (typeof WIZARD_STEPS)[number]['id']

export const wizardStepIndex = (id: WizardStepId): number =>
  WIZARD_STEPS.findIndex((step) => step.id === id)

/** One quintillion: the fixed-point unit every score is expressed in. */
const ONE = 1_000_000_000_000_000_000n

/**
 * Everything that is the same for every network on trustgraphs. These are the envelope the proving
 * program is checked against plus the three fields that identify the instance (which the factory
 * derives and rejects if supplied), so none of them is a choice a community gets to make.
 */
export const FIXED_PARAMS = {
  toleranceFp: 1_000_000_000_000n,
  maxIterations: 100,
  minWeightFp: 0n,
  maxWeightFp: 100n * ONE,
  precisionScale: ONE,
  schemaUid:
    '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
  weightFieldIndex: 1,
  envelope0DomainSeparators: [] as readonly Hex[],
  lane2MaxHeadAge: 0n,
  accumulator: zeroAddress as Hex,
  chainId: 0n,
} as const

export type Cadence =
  | 'monthly'
  | 'weekly'
  | 'daily'
  | 'hourly'
  | 'tenMinutes'
  | 'fastest'

/** Twelve-second blocks: the assumption behind every duration this wizard quotes. */
const SECONDS_PER_BLOCK = 12
const CADENCE_BLOCKS: Record<Exclude<Cadence, 'fastest'>, bigint> = {
  monthly: BigInt(Math.round((30 * 24 * 60 * 60) / SECONDS_PER_BLOCK)),
  weekly: BigInt(Math.round((7 * 24 * 60 * 60) / SECONDS_PER_BLOCK)),
  daily: BigInt(Math.round((24 * 60 * 60) / SECONDS_PER_BLOCK)),
  // Testnet-fast schedules. Below the original factory generation's floor (7200), so on a
  // deployment without the fast factories they clamp to the floor and the wizard says so.
  hourly: BigInt(Math.round((60 * 60) / SECONDS_PER_BLOCK)),
  tenMinutes: BigInt(Math.round((10 * 60) / SECONDS_PER_BLOCK)),
}

export const CADENCE_OPTIONS: { value: Cadence; label: string }[] = [
  { value: 'monthly', label: 'About once a month' },
  { value: 'weekly', label: 'About once a week' },
  { value: 'daily', label: 'About once a day' },
  { value: 'hourly', label: 'Hourly (testnet)' },
  { value: 'tenMinutes', label: 'Every 10 minutes (testnet)' },
  { value: 'fastest', label: 'As often as this chain allows' },
]

/**
 * The knobs the "advanced" section exposes, in the units a person reads them in. The full seed
 * share is the safe default; any remainder is divided only among accounts reachable from a seed.
 */
export type Tuning = {
  /** Damping, as a percentage. */
  vouchWeightPct: number
  /** Trust share, as a percentage. */
  headStartPct: number
  /** Trust decay, as a percentage kept per step. */
  headStartKeptPct: number
  /** Total pool, in whole points. */
  totalPoints: number
  cadence: Cadence
}

export const DEFAULT_TUNING: Tuning = {
  vouchWeightPct: 85,
  headStartPct: FULL_SEED_TRUST_SHARE_PCT,
  headStartKeptPct: 80,
  totalPoints: 1_000_000,
  cadence: 'fastest',
}

export type FundToken = 'eth' | 'other'
export type SubnetworkTier = 'admin' | 'guardian' | 'label'

export type WizardData = {
  name: string
  description: string
  criteria: string
  image: string
  applicationUrl: string
  seeds: Hex[]
  /** Normalized ENS names keyed by their resolved, canonical seed address. */
  seedNames: Record<string, string>
  tuning: Tuning
  withFund: boolean
  fundToken: FundToken
  fundTokenAddress: string
  /**
   * ETH to put in the network's proving tank at creation, as a decimal string. Empty means none,
   * which is the normal case: scores still refresh, they just depend on somebody choosing to do
   * the work rather than being paid for it.
   */
  prepayEth: string
  /** Maximum combined proving fee and gas reimbursement paid for one root, in oracle USD. */
  maxPerRootUsd: string
  /** Install the score-selected Safe signer module in the same governed creation transaction. */
  withSignerSync: boolean
  /** Add the strict, retained off-chain EAS v2 lane. On-chain-only remains the default. */
  withOffchainVouches: boolean
  /** Immutable combined lane-1 + strict-lane work ceiling. */
  offchainMaxTotalInputs: number
  /** Number of highest-scoring accounts considered for Safe ownership. */
  signerTopN: number
  /** Absolute lower bound for the Safe threshold. */
  signerMinThreshold: number
  /** Fraction of selected signers required, in the percentage shown by the UI. */
  signerTargetThresholdPct: number
  /** Parent power chosen only when the wizard is opened from a parent network. */
  subnetworkTier: SubnetworkTier
}

export const EMPTY_WIZARD_DATA: WizardData = {
  name: '',
  description: '',
  criteria: '',
  image: '',
  applicationUrl: '',
  seeds: [],
  seedNames: {},
  tuning: DEFAULT_TUNING,
  withFund: false,
  fundToken: 'eth',
  fundTokenAddress: '',
  prepayEth: '',
  maxPerRootUsd: DEFAULT_MAX_PER_ROOT_USD,
  withSignerSync: false,
  withOffchainVouches: false,
  offchainMaxTotalInputs: MAX_OFFCHAIN_TOTAL_INPUTS,
  signerTopN: 5,
  signerMinThreshold: 2,
  signerTargetThresholdPct: 50,
  subnetworkTier: 'admin',
}

/** The presentation blob the on-chain `metadataURI` points at. Nothing here affects scores. */
export type NetworkMetadata = {
  name: string
  description: string
  criteria: string
  image: string
  applicationUrl: string
}

export const metadataFrom = (data: WizardData): NetworkMetadata => ({
  name: data.name.trim(),
  description: data.description.trim(),
  criteria: data.criteria.trim(),
  image: data.image.trim(),
  applicationUrl: data.applicationUrl.trim(),
})

/** A cheap identity for "have the identity fields changed since we last pinned?". */
export const metadataFingerprint = (metadata: NetworkMetadata) =>
  JSON.stringify(metadata)

/** A percentage the screens show (85) into the fixed-point fraction the chain wants (0.85 * 1e18). */
const pctToFp = (pct: number) => BigInt(Math.round(pct * 100)) * 10n ** 14n

/**
 * A fresh 32-byte salt per wizard session. It only exists so the same person can create two
 * networks with the same name without the second one colliding with the first.
 */
export const randomSalt = (): Hex => {
  const bytes = new Uint8Array(32)
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  return `0x${Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}` as Hex
}

export const byteLength = (value: string) =>
  new TextEncoder().encode(value).length

/*//////////////////////////////////////////////////////////////
                        SCHEDULE
//////////////////////////////////////////////////////////////*/

/** Blocks the community asked for, before the chain's own floor is applied. */
export const requestedBlocks = (cadence: Cadence, floor: bigint): bigint =>
  cadence === 'fastest' ? floor : CADENCE_BLOCKS[cadence]

/** What the community will actually get: the factory raises anything below the floor. */
export const effectiveBlocks = (cadence: Cadence, floor: bigint): bigint => {
  const requested = requestedBlocks(cadence, floor)
  return requested < floor ? floor : requested
}

/** A duration in words, from a number of blocks. */
export const describeBlocks = (blocks: bigint): string => {
  // We have not read the chain's own limit yet, so do not invent a schedule.
  if (blocks === 0n) {
    return 'as often as this chain allows'
  }

  if (IS_LOCAL_CHAIN) {
    return blocks === 1n
      ? 'every block on this test chain'
      : `every ${blocks.toLocaleString()} blocks on this test chain`
  }

  const seconds = Number(blocks) * SECONDS_PER_BLOCK
  const days = seconds / 86_400
  if (days >= 25) {
    const months = Math.round(days / 30)
    return months <= 1 ? 'about once a month' : `about every ${months} months`
  }
  if (days >= 6) {
    const weeks = Math.round(days / 7)
    return weeks <= 1 ? 'about once a week' : `about every ${weeks} weeks`
  }
  if (days >= 0.9) {
    const rounded = Math.round(days)
    return rounded <= 1 ? 'about once a day' : `about every ${rounded} days`
  }
  const hours = seconds / 3_600
  if (hours >= 0.9) {
    const rounded = Math.max(1, Math.round(hours))
    return rounded <= 1 ? 'about once an hour' : `about every ${rounded} hours`
  }
  const minutes = Math.max(1, Math.round(seconds / 60))
  return minutes <= 1 ? 'about once a minute' : `about every ${minutes} minutes`
}

/*//////////////////////////////////////////////////////////////
                        VALIDATION
//////////////////////////////////////////////////////////////*/

export const nameProblem = (name: string): string | null => {
  const trimmed = name.trim()
  if (!trimmed) {
    return 'Your network needs a name.'
  }
  if (byteLength(trimmed) > MAX_NAME_BYTES) {
    return `That name is too long. Keep it to ${MAX_NAME_BYTES} characters or fewer.`
  }
  return null
}

export const urlProblem = (value: string): string | null => {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  if (
    !trimmed.startsWith('https://') &&
    !trimmed.startsWith('http://') &&
    !trimmed.startsWith('ipfs://')
  ) {
    return 'Links need to start with https:// (or ipfs:// for something stored on IPFS).'
  }
  return null
}

/**
 * Pull addresses out of whatever a person pasted: one per line, comma separated, or all on one
 * line. Returns the ones that look like addresses, plus whatever it could not make sense of.
 */
export const parseAddressList = (
  input: string
): { addresses: Hex[]; names: string[]; rejected: string[] } => {
  const tokens = input
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter(Boolean)

  const addresses: Hex[] = []
  const names: string[] = []
  const rejected: string[] = []
  for (const token of tokens) {
    const parsed = parseAccountIdentifier(token)
    if (parsed.kind === 'address') addresses.push(token.toLowerCase() as Hex)
    else if (parsed.kind === 'ens') names.push(parsed.name)
    else rejected.push(token)
  }
  return { addresses, names, rejected }
}

export const seedProblem = (candidate: Hex, existing: Hex[]): string | null => {
  if (candidate === zeroAddress) {
    return 'That address is all zeros. Nobody controls it, so it cannot vouch for anyone.'
  }
  if (existing.some((seed) => seed.toLowerCase() === candidate.toLowerCase())) {
    return 'That account is already on the list.'
  }
  if (existing.length >= MAX_SEEDS) {
    return `You can pick up to ${MAX_SEEDS} starting accounts.`
  }
  return null
}

/** The prepay must parse as a non-negative decimal, or the create transaction reverts on send. */
export const prepayProblem = (data: WizardData): string | null => {
  const trimmed = data.prepayEth.trim()
  if (!trimmed) return null
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '.') {
    return 'Enter an amount like 0.5, or leave it blank.'
  }
  if (Number(trimmed) === 0) {
    return 'Leave it blank rather than entering zero.'
  }
  return initialPolicyProblem(data.prepayEth, data.maxPerRootUsd)
}

export const fundTokenProblem = (data: WizardData): string | null => {
  if (!data.withFund || data.fundToken === 'eth') {
    return null
  }
  const trimmed = data.fundTokenAddress.trim()
  if (!trimmed) {
    return 'Paste the address of the token you plan to pay out.'
  }
  if (!isAddress(trimmed, { strict: false })) {
    return "That doesn't look like a token address."
  }
  return null
}

export const isSignerSyncAvailable = (): boolean => {
  const verifier = SIGNER_SYNC_CONFIG?.verifier ?? ''
  const programVKey = SIGNER_SYNC_CONFIG?.programVKey ?? ''
  return (
    isAddress(verifier, { strict: false }) &&
    verifier.toLowerCase() !== zeroAddress &&
    isHex(programVKey, { strict: true }) &&
    programVKey.length === 66 &&
    !/^0x0{64}$/i.test(programVKey)
  )
}

export const signerSyncProblem = (data: WizardData): string | null => {
  if (!data.withSignerSync) return null
  if (data.withOffchainVouches) {
    return 'Score-selected Safe signers cannot be combined with gasless off-chain vouches.'
  }
  if (!isSignerSyncAvailable()) {
    return 'Score-selected Safe signers are not configured on this deployment.'
  }
  if (
    !Number.isInteger(data.signerTopN) ||
    data.signerTopN < 2 ||
    data.signerTopN > 64
  ) {
    return 'Choose between 2 and 64 score-selected signers.'
  }
  if (
    !Number.isInteger(data.signerMinThreshold) ||
    data.signerMinThreshold < 2 ||
    data.signerMinThreshold > data.signerTopN
  ) {
    return 'The minimum threshold must be at least 2 and no larger than the signer count.'
  }
  if (
    !Number.isFinite(data.signerTargetThresholdPct) ||
    data.signerTargetThresholdPct < 1 ||
    data.signerTargetThresholdPct > 100
  ) {
    return 'The target threshold must be between 1% and 100%.'
  }
  return null
}

export const offchainVouchesProblem = (data: WizardData): string | null => {
  if (!data.withOffchainVouches) return null
  if (!isOffchainVouchCreationAvailable()) {
    return 'This deployment needs between 2 and 16 distinct public relayer addresses before it can create a gasless off-chain lane.'
  }
  if (
    !Number.isInteger(data.offchainMaxTotalInputs) ||
    data.offchainMaxTotalInputs < 1 ||
    data.offchainMaxTotalInputs > MAX_OFFCHAIN_TOTAL_INPUTS
  ) {
    return `Choose an immutable work cap between 1 and ${MAX_OFFCHAIN_TOTAL_INPUTS.toLocaleString()}.`
  }
  if (data.withSignerSync) {
    return 'Turn off score-selected Safe signers before enabling gasless off-chain vouches.'
  }
  return null
}

/*//////////////////////////////////////////////////////////////
                    BUILDING THE TRANSACTION
//////////////////////////////////////////////////////////////*/

export type FactoryParams = {
  dampingFp: bigint
  toleranceFp: bigint
  maxIterations: number
  minWeightFp: bigint
  maxWeightFp: bigint
  trustShareFp: bigint
  trustDecayFp: bigint
  trustedSeeds: readonly Hex[]
  totalPool: bigint
  precisionScale: bigint
  schemaUid: Hex
  weightFieldIndex: number
  envelope0DomainSeparators: readonly Hex[]
  lane2MaxHeadAge: bigint
  accumulator: Hex
  chainId: bigint
}

export type CreateArgs = {
  name: string
  metadataURI: string
  params: FactoryParams
  admin: Hex
  epochLength: bigint
  withDistributor: boolean
  distributorToken: Hex
  salt: Hex
}

export type SignerSyncCreateConfig = {
  enabled: boolean
  topN: number
  minThreshold: number
  targetThresholdBps: number
}

export type OffchainEasCreateConfig = {
  maxTotalInputs: bigint
  initialRelayers: readonly Hex[]
}

export const buildOffchainEasConfig = (
  data: WizardData
): OffchainEasCreateConfig => ({
  maxTotalInputs: BigInt(data.offchainMaxTotalInputs),
  initialRelayers: OFFCHAIN_INITIAL_RELAYERS,
})

/** Exact optional module config consumed by `createGovernedInstance`. */
export const buildSignerSyncConfig = (
  data: WizardData
): SignerSyncCreateConfig =>
  data.withSignerSync
    ? {
        enabled: true,
        topN: data.signerTopN,
        minThreshold: data.signerMinThreshold,
        targetThresholdBps: Math.round(data.signerTargetThresholdPct * 100),
      }
    : {
        enabled: false,
        topN: 0,
        minThreshold: 0,
        targetThresholdBps: 0,
      }

export const buildParams = (data: WizardData): FactoryParams => ({
  dampingFp: pctToFp(data.tuning.vouchWeightPct),
  toleranceFp: FIXED_PARAMS.toleranceFp,
  maxIterations: FIXED_PARAMS.maxIterations,
  minWeightFp: FIXED_PARAMS.minWeightFp,
  maxWeightFp: FIXED_PARAMS.maxWeightFp,
  trustShareFp: pctToFp(data.tuning.headStartPct),
  trustDecayFp: pctToFp(data.tuning.headStartKeptPct),
  trustedSeeds: data.seeds,
  totalPool: BigInt(Math.max(0, Math.round(data.tuning.totalPoints))) * ONE,
  precisionScale: FIXED_PARAMS.precisionScale,
  schemaUid: FIXED_PARAMS.schemaUid,
  weightFieldIndex: FIXED_PARAMS.weightFieldIndex,
  envelope0DomainSeparators: FIXED_PARAMS.envelope0DomainSeparators,
  lane2MaxHeadAge: FIXED_PARAMS.lane2MaxHeadAge,
  accumulator: FIXED_PARAMS.accumulator,
  chainId: FIXED_PARAMS.chainId,
})

export const buildCreateArgs = ({
  data,
  metadataURI,
  admin,
  epochFloor,
  salt,
}: {
  data: WizardData
  metadataURI: string
  admin: Hex
  epochFloor: bigint
  salt: Hex
}): CreateArgs => ({
  name: data.name.trim(),
  metadataURI,
  params: buildParams(data),
  admin,
  epochLength: requestedBlocks(data.tuning.cadence, epochFloor),
  withDistributor: data.withFund,
  distributorToken: !data.withFund
    ? zeroAddress
    : data.fundToken === 'eth'
      ? zeroAddress
      : (data.fundTokenAddress.trim().toLowerCase() as Hex),
  salt,
})

/*//////////////////////////////////////////////////////////////
                        ERROR TRANSLATION
//////////////////////////////////////////////////////////////*/

/**
 * The factory refuses bad settings with named errors. Say what the person can do about it, in the
 * words the screens used, rather than showing the raw revert.
 */
const FACTORY_ERROR_COPY: [string, string][] = [
  [
    'HybridSignerSyncUnsupported',
    'Score-selected Safe signers cannot be installed on a network with strict off-chain vouches.',
  ],
  [
    'InvalidRelayerCount',
    'Gasless off-chain vouches need between 2 and 16 distinct initial relayers.',
  ],
  [
    'InvalidRelayer',
    'The configured initial relayer set contains a zero or duplicate address.',
  ],
  [
    'InvalidInputCapacity',
    `The immutable proof-work cap must be between 1 and ${MAX_OFFCHAIN_TOTAL_INPUTS.toLocaleString()}.`,
  ],
  ['EmptyName', 'Your network needs a name.'],
  [
    'NameTooLong',
    `That name is too long. Keep it to ${MAX_NAME_BYTES} characters or fewer.`,
  ],
  ['NoTrustedSeeds', 'Pick at least one account to start trust from.'],
  ['TooManyTrustedSeeds', `You can pick up to ${MAX_SEEDS} starting accounts.`],
  [
    'InvalidSeed',
    'One of your starting accounts is listed twice, or is the all-zero address.',
  ],
  [
    'InvalidDamping',
    'How much scores lean on vouches has to be between 1% and 99%.',
  ],
  [
    'InvalidTrustShare',
    "The head start for your starting accounts can't be more than 100%.",
  ],
  [
    'InvalidTrustDecay',
    "The amount of weight kept at each step can't be more than 100%.",
  ],
  [
    'InvalidTotalPool',
    'Total points shared out has to be more than zero, otherwise everyone scores zero forever.',
  ],
  [
    'InstanceAlreadyExists',
    'You already created a network with this exact name. Change the name and try again.',
  ],
  [
    'InitialFeeUnpriced',
    'This deployment has not priced its initial proving band yet. Do not prepay until the operator configures the global fee schedule.',
  ],
  [
    'InitialCapBelowFee',
    'Your per-refresh maximum is below this deployment’s initial proving fee. Raise the cap or create an unpaid network.',
  ],
  [
    'PrepayUnavailable',
    'This deployment has no proving vault, so it cannot accept a refresh prepayment.',
  ],
  [
    'PrepayRequiresPolicy',
    'A refresh prepayment needs a nonzero per-refresh policy.',
  ],
  [
    'PolicyRequiresPrepay',
    'Remove the paid policy or add ETH for score refreshes.',
  ],
  [
    'InitialPaidIntervalTooShort',
    'Paid refreshes cannot start more often than scores can be published.',
  ],
  [
    'InitialCapTooHigh',
    'The creation-time maximum cannot exceed $10,000 per refresh.',
  ],
]

/** Settings this wizard fills in itself. If one of these fires, the bug is ours, not theirs. */
const INTERNAL_ERRORS = [
  'DerivedFieldNotZero',
  'InvalidTolerance',
  'InvalidIterations',
  'InvalidWeightBounds',
  'InvalidPrecisionScale',
  'InvalidWeightFieldIndex',
  'Lane2NotSupported',
]

export const explainFactoryError = (error: unknown): string => {
  const text = String(error instanceof Error ? error.message : (error ?? ''))

  for (const [name, copy] of FACTORY_ERROR_COPY) {
    if (text.includes(name)) {
      return copy
    }
  }
  for (const name of INTERNAL_ERRORS) {
    if (text.includes(name)) {
      return 'This app sent a setting the network does not accept. That is a bug on our side: please reload and try again.'
    }
  }
  if (/user rejected|user denied/i.test(text)) {
    return 'You rejected the request.'
  }
  return text.split('\n')[0] || 'Something went wrong.'
}
