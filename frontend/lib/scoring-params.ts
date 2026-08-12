import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeFunctionData,
  isAddress,
  keccak256,
  stringToBytes,
  zeroAddress,
} from 'viem'

import { paramsHash } from './pagerank/encode'
import type { Params } from './pagerank/types'

/** JSON-safe representation used by the catalog and version-history API. */
export type ExactParamsJson = {
  dampingFp: string
  toleranceFp: string
  maxIterations: number
  minWeightFp: string
  maxWeightFp: string
  trustMultiplierFp: string
  trustShareFp: string
  trustDecayFp: string
  trustedSeeds: Hex[]
  totalPool: string
  precisionScale: string
  schemaUid: Hex
  weightFieldIndex: number
  envelope0DomainSeparators: Hex[]
  lane2MaxHeadAge: string
  accumulator: Hex
  chainId: string
}

export const PARAMS_SCALE = 10n ** 18n
export const MAX_TOLERANCE_FP = 10n ** 15n
export const MAX_ITERATIONS = 500
export const MAX_TRUST_MULTIPLIER_FP = 100n * PARAMS_SCALE
export const MAX_WEIGHT_FP = 1_000_000n * PARAMS_SCALE
export const MAX_TRUSTED_SEEDS = 64
const MAX_UINT256 = (1n << 256n) - 1n
const MAX_RANK_FP = MAX_UINT256 / PARAMS_SCALE

export const paramsComponents = [
  { name: 'dampingFp', internalType: 'uint256', type: 'uint256' },
  { name: 'toleranceFp', internalType: 'uint256', type: 'uint256' },
  { name: 'maxIterations', internalType: 'uint32', type: 'uint32' },
  { name: 'minWeightFp', internalType: 'uint256', type: 'uint256' },
  { name: 'maxWeightFp', internalType: 'uint256', type: 'uint256' },
  {
    name: 'trustMultiplierFp',
    internalType: 'uint256',
    type: 'uint256',
  },
  { name: 'trustShareFp', internalType: 'uint256', type: 'uint256' },
  { name: 'trustDecayFp', internalType: 'uint256', type: 'uint256' },
  { name: 'trustedSeeds', internalType: 'address[]', type: 'address[]' },
  { name: 'totalPool', internalType: 'uint256', type: 'uint256' },
  { name: 'precisionScale', internalType: 'uint256', type: 'uint256' },
  { name: 'schemaUid', internalType: 'bytes32', type: 'bytes32' },
  { name: 'weightFieldIndex', internalType: 'uint32', type: 'uint32' },
  {
    name: 'envelope0DomainSeparators',
    internalType: 'bytes32[]',
    type: 'bytes32[]',
  },
  { name: 'lane2MaxHeadAge', internalType: 'uint64', type: 'uint64' },
  { name: 'accumulator', internalType: 'address', type: 'address' },
  { name: 'chainId', internalType: 'uint64', type: 'uint64' },
] as const

export const trustGraphParamsControllerAbi = [
  {
    type: 'function',
    name: 'getCurrentParams',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: '',
        internalType: 'struct ParamsCodec.Params',
        type: 'tuple',
        components: paramsComponents,
      },
    ],
  },
  {
    type: 'function',
    name: 'updateParams',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'next',
        internalType: 'struct ParamsCodec.Params',
        type: 'tuple',
        components: paramsComponents,
      },
      { name: 'evidenceURI', internalType: 'string', type: 'string' },
    ],
    outputs: [
      { name: 'newVersion', internalType: 'uint64', type: 'uint64' },
      { name: 'newHash', internalType: 'bytes32', type: 'bytes32' },
    ],
  },
  {
    type: 'function',
    name: 'instanceId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'snapshot',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
  },
  {
    type: 'function',
    name: 'registry',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
  },
  {
    type: 'function',
    name: 'version',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', internalType: 'uint64', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'currentParamsHash',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
  },
  {
    type: 'function',
    name: 'pendingOwner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
  },
] as const

export const paramsDiscoveryAbi = [
  {
    type: 'function',
    name: 'INSTANCE_REGISTRY',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
  },
  {
    type: 'function',
    name: 'paramsAuthority',
    stateMutability: 'view',
    inputs: [{ name: 'instanceId', internalType: 'bytes32', type: 'bytes32' }],
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
  },
] as const

export const signerParamsAbi = [
  {
    type: 'function',
    name: 'paramsHash',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'paramsAuthority',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
  },
  {
    type: 'function',
    name: 'setParamsHash',
    stateMutability: 'nonpayable',
    inputs: [{ name: '_paramsHash', internalType: 'bytes32', type: 'bytes32' }],
    outputs: [],
  },
] as const

export const safeReadAbi = [
  {
    type: 'function',
    name: 'getOwners',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', internalType: 'address[]', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getThreshold',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
  },
] as const

export const timelockAbi = [
  {
    type: 'function',
    name: 'PROPOSER_ROLE',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'EXECUTOR_ROLE',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'getMinDelay',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'hasRole',
    stateMutability: 'view',
    inputs: [
      { name: 'role', internalType: 'bytes32', type: 'bytes32' },
      { name: 'account', internalType: 'address', type: 'address' },
    ],
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'hashOperationBatch',
    stateMutability: 'view',
    inputs: [
      { name: 'targets', internalType: 'address[]', type: 'address[]' },
      { name: 'values', internalType: 'uint256[]', type: 'uint256[]' },
      { name: 'payloads', internalType: 'bytes[]', type: 'bytes[]' },
      { name: 'predecessor', internalType: 'bytes32', type: 'bytes32' },
      { name: 'salt', internalType: 'bytes32', type: 'bytes32' },
    ],
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'getTimestamp',
    stateMutability: 'view',
    inputs: [{ name: 'id', internalType: 'bytes32', type: 'bytes32' }],
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'scheduleBatch',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'targets', internalType: 'address[]', type: 'address[]' },
      { name: 'values', internalType: 'uint256[]', type: 'uint256[]' },
      { name: 'payloads', internalType: 'bytes[]', type: 'bytes[]' },
      { name: 'predecessor', internalType: 'bytes32', type: 'bytes32' },
      { name: 'salt', internalType: 'bytes32', type: 'bytes32' },
      { name: 'delay', internalType: 'uint256', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'executeBatch',
    stateMutability: 'payable',
    inputs: [
      { name: 'targets', internalType: 'address[]', type: 'address[]' },
      { name: 'values', internalType: 'uint256[]', type: 'uint256[]' },
      { name: 'payloads', internalType: 'bytes[]', type: 'bytes[]' },
      { name: 'predecessor', internalType: 'bytes32', type: 'bytes32' },
      { name: 'salt', internalType: 'bytes32', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const

const valueAt = (tuple: unknown, name: string, index: number): unknown => {
  if (Array.isArray(tuple)) return tuple[index]
  if (tuple && typeof tuple === 'object') {
    return (tuple as Record<string, unknown>)[name]
  }
  return undefined
}

const bigintAt = (tuple: unknown, name: string, index: number): bigint => {
  const value = valueAt(tuple, name, index)
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' || typeof value === 'string') {
    return BigInt(value)
  }
  throw new Error(`Controller returned an invalid ${name}`)
}

const numberAt = (tuple: unknown, name: string, index: number): number => {
  const value = bigintAt(tuple, name, index)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Controller returned an out-of-range ${name}`)
  }
  return Number(value)
}

const hexAt = (tuple: unknown, name: string, index: number): Hex => {
  const value = valueAt(tuple, name, index)
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new Error(`Controller returned an invalid ${name}`)
  }
  return value.toLowerCase() as Hex
}

const hexArrayAt = (tuple: unknown, name: string, index: number): Hex[] => {
  const value = valueAt(tuple, name, index)
  if (!Array.isArray(value)) {
    throw new Error(`Controller returned an invalid ${name}`)
  }
  return value.map((entry) => String(entry).toLowerCase() as Hex)
}

/** Normalize viem's named or positional tuple without ever passing through JS numbers. */
export const paramsFromChain = (tuple: unknown): Params => ({
  dampingFp: bigintAt(tuple, 'dampingFp', 0),
  toleranceFp: bigintAt(tuple, 'toleranceFp', 1),
  maxIterations: numberAt(tuple, 'maxIterations', 2),
  minWeightFp: bigintAt(tuple, 'minWeightFp', 3),
  maxWeightFp: bigintAt(tuple, 'maxWeightFp', 4),
  trustMultiplierFp: bigintAt(tuple, 'trustMultiplierFp', 5),
  trustShareFp: bigintAt(tuple, 'trustShareFp', 6),
  trustDecayFp: bigintAt(tuple, 'trustDecayFp', 7),
  trustedSeeds: hexArrayAt(tuple, 'trustedSeeds', 8),
  totalPool: bigintAt(tuple, 'totalPool', 9),
  precisionScale: bigintAt(tuple, 'precisionScale', 10),
  schemaUid: hexAt(tuple, 'schemaUid', 11),
  weightFieldIndex: numberAt(tuple, 'weightFieldIndex', 12),
  envelope0DomainSeparators: hexArrayAt(tuple, 'envelope0DomainSeparators', 13),
  lane2MaxHeadAge: bigintAt(tuple, 'lane2MaxHeadAge', 14),
  accumulator: hexAt(tuple, 'accumulator', 15),
  chainId: bigintAt(tuple, 'chainId', 16),
})

export const paramsFromJson = (params: ExactParamsJson): Params => ({
  dampingFp: BigInt(params.dampingFp),
  toleranceFp: BigInt(params.toleranceFp),
  maxIterations: params.maxIterations,
  minWeightFp: BigInt(params.minWeightFp),
  maxWeightFp: BigInt(params.maxWeightFp),
  trustMultiplierFp: BigInt(params.trustMultiplierFp),
  trustShareFp: BigInt(params.trustShareFp),
  trustDecayFp: BigInt(params.trustDecayFp),
  trustedSeeds: params.trustedSeeds.map((seed) => seed.toLowerCase() as Hex),
  totalPool: BigInt(params.totalPool),
  precisionScale: BigInt(params.precisionScale),
  schemaUid: params.schemaUid.toLowerCase() as Hex,
  weightFieldIndex: params.weightFieldIndex,
  envelope0DomainSeparators: params.envelope0DomainSeparators.map(
    (domain) => domain.toLowerCase() as Hex
  ),
  lane2MaxHeadAge: BigInt(params.lane2MaxHeadAge),
  accumulator: params.accumulator.toLowerCase() as Hex,
  chainId: BigInt(params.chainId),
})

export const paramsToJson = (params: Params): ExactParamsJson => ({
  dampingFp: params.dampingFp.toString(),
  toleranceFp: params.toleranceFp.toString(),
  maxIterations: params.maxIterations,
  minWeightFp: params.minWeightFp.toString(),
  maxWeightFp: params.maxWeightFp.toString(),
  trustMultiplierFp: params.trustMultiplierFp.toString(),
  trustShareFp: params.trustShareFp.toString(),
  trustDecayFp: params.trustDecayFp.toString(),
  trustedSeeds: params.trustedSeeds,
  totalPool: params.totalPool.toString(),
  precisionScale: params.precisionScale.toString(),
  schemaUid: params.schemaUid,
  weightFieldIndex: params.weightFieldIndex,
  envelope0DomainSeparators: params.envelope0DomainSeparators ?? [],
  lane2MaxHeadAge: BigInt(params.lane2MaxHeadAge ?? 0).toString(),
  accumulator: params.accumulator,
  chainId: BigInt(params.chainId).toString(),
})

/** Contract-call shape. Keep uint64 values bigint; viem performs the final ABI boundary check. */
export const paramsToContract = (params: Params) => ({
  ...params,
  trustedSeeds: params.trustedSeeds as readonly Address[],
  envelope0DomainSeparators: params.envelope0DomainSeparators ?? [],
  lane2MaxHeadAge: BigInt(params.lane2MaxHeadAge ?? 0),
  chainId: BigInt(params.chainId),
})

/** Exact fixed-point display. No Number conversion, scientific notation, or rounding. */
export const formatFixed = (raw: bigint, scale = PARAMS_SCALE): string => {
  const negative = raw < 0n
  const value = negative ? -raw : raw
  const digits = scale.toString().length - 1
  const fraction = (value % scale)
    .toString()
    .padStart(digits, '0')
    .replace(/0+$/, '')
  return `${negative ? '-' : ''}${value / scale}${fraction ? `.${fraction}` : ''}`
}

/** Human decimal → fixed point, rejecting rather than rounding excess precision. */
export const parseFixed = (input: string, scale = PARAMS_SCALE): bigint => {
  const match = input.trim().match(/^(\d+)(?:\.(\d+))?$/)
  if (!match) throw new Error('Enter a non-negative decimal number')
  const digits = scale.toString().length - 1
  const fraction = match[2] ?? ''
  if (fraction.length > digits) {
    throw new Error(`Use at most ${digits} decimal places`)
  }
  return BigInt(match[1]) * scale + BigInt(fraction.padEnd(digits, '0') || '0')
}

const stableObject = (params: Params) => {
  const json = paramsToJson(params)
  return {
    ...json,
    trustedSeeds: json.trustedSeeds.map((seed) => seed.toLowerCase()),
    envelope0DomainSeparators: json.envelope0DomainSeparators.map((domain) =>
      domain.toLowerCase()
    ),
    schemaUid: json.schemaUid.toLowerCase(),
    accumulator: json.accumulator.toLowerCase(),
  }
}

export const serializeParams = (params: Params): string =>
  JSON.stringify(stableObject(params))

export const paramsFingerprint = (params: Params): Hex =>
  keccak256(stringToBytes(serializeParams(params)))

export const cloneParams = (params: Params): Params =>
  paramsFromJson(paramsToJson(params))

export type ParamsValidation = {
  valid: boolean
  errors: Record<string, string>
  interactionWarning?: string
}

const identityChanged = (next: Params, initial: Params) =>
  next.schemaUid.toLowerCase() !== initial.schemaUid.toLowerCase() ||
  next.accumulator.toLowerCase() !== initial.accumulator.toLowerCase() ||
  BigInt(next.chainId) !== BigInt(initial.chainId) ||
  next.precisionScale !== initial.precisionScale ||
  next.weightFieldIndex !== initial.weightFieldIndex ||
  BigInt(next.lane2MaxHeadAge ?? 0) !== BigInt(initial.lane2MaxHeadAge ?? 0) ||
  JSON.stringify(next.envelope0DomainSeparators ?? []) !==
    JSON.stringify(initial.envelope0DomainSeparators ?? [])

/** Exact TypeScript mirror of TrustGraphParamsValidator's update envelope. */
export const validateParamsUpdate = (
  next: Params,
  initial: Params,
  currentHash?: Hex
): ParamsValidation => {
  const errors: Record<string, string> = {}
  if (next.dampingFp <= 0n || next.dampingFp >= PARAMS_SCALE) {
    errors.dampingFp = 'Damping must be greater than 0 and less than 1.'
  }
  if (next.toleranceFp <= 0n || next.toleranceFp > MAX_TOLERANCE_FP) {
    errors.toleranceFp = 'Tolerance must be greater than 0 and at most 0.001.'
  }
  if (next.maxIterations < 1 || next.maxIterations > MAX_ITERATIONS) {
    errors.maxIterations = `Iterations must be between 1 and ${MAX_ITERATIONS}.`
  }
  if (
    next.maxWeightFp <= 0n ||
    next.minWeightFp > next.maxWeightFp ||
    next.maxWeightFp > MAX_WEIGHT_FP
  ) {
    errors.weights =
      'Maximum weight must be positive, at least the minimum, and no more than 1,000,000.'
  }
  if (next.trustShareFp < 0n || next.trustShareFp > PARAMS_SCALE) {
    errors.trustShareFp = 'Starting share must be between 0 and 1.'
  }
  if (next.trustDecayFp < 0n || next.trustDecayFp > PARAMS_SCALE) {
    errors.trustDecayFp = 'Distance decay must be between 0 and 1.'
  }
  if (
    next.trustMultiplierFp < 0n ||
    next.trustMultiplierFp > MAX_TRUST_MULTIPLIER_FP
  ) {
    errors.trustMultiplierFp =
      'Trusted-account boost must be between 0 and 100.'
  }
  if (next.precisionScale !== PARAMS_SCALE) {
    errors.precisionScale = 'This program requires a precision scale of 1e18.'
  }
  if (next.totalPool <= 0n) {
    errors.totalPool = 'The points pool must be greater than zero.'
  }
  if (next.weightFieldIndex !== 1) {
    errors.weightFieldIndex = 'The vouch weight field index must remain 1.'
  }
  if (
    next.trustedSeeds.length < 1 ||
    next.trustedSeeds.length > MAX_TRUSTED_SEEDS
  ) {
    errors.trustedSeeds = `Use between 1 and ${MAX_TRUSTED_SEEDS} trusted accounts.`
  } else {
    const seen = new Set<string>()
    for (const seed of next.trustedSeeds) {
      const normalized = seed.toLowerCase()
      if (!isAddress(seed) || normalized === zeroAddress) {
        errors.trustedSeeds =
          'Every trusted account must be a non-zero address.'
        break
      }
      if (seen.has(normalized)) {
        errors.trustedSeeds = 'Trusted accounts must be unique.'
        break
      }
      seen.add(normalized)
    }
  }
  if (
    (next.envelope0DomainSeparators?.length ?? 0) !== 0 ||
    BigInt(next.lane2MaxHeadAge ?? 0) !== 0n
  ) {
    errors.lane2 = 'Lane 2 is not supported by this trust-graph factory.'
  }
  if (identityChanged(next, initial)) {
    errors.identity =
      'Fixed program and instance identity fields cannot change here.'
  }

  const factor = (next.dampingFp * next.trustMultiplierFp) / PARAMS_SCALE
  if (factor > PARAMS_SCALE) {
    let growth = PARAMS_SCALE
    for (let i = 0; i < next.maxIterations; i++) {
      if (growth > MAX_UINT256 / factor) {
        errors.growth =
          'Damping × trusted boost compounds beyond the guest safety bound at this iteration cap.'
        break
      }
      growth = (growth * factor) / PARAMS_SCALE
      if (growth > MAX_RANK_FP) {
        errors.growth =
          'Damping × trusted boost compounds beyond the guest safety bound at this iteration cap.'
        break
      }
    }
  }

  if (
    currentHash &&
    paramsHash(next).toLowerCase() === currentHash.toLowerCase()
  ) {
    errors.noop = 'Change at least one editable field before proposing.'
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    ...(factor > PARAMS_SCALE
      ? {
          interactionWarning:
            'Damping and trusted-account boost compound on every iteration. The contract checks their combined worst-case growth, not either field alone.',
        }
      : {}),
  }
}

export type ParamsDiff = {
  field: keyof ExactParamsJson
  label: string
  before: string
  after: string
  important?: boolean
}

const DISPLAY_FIELDS: Array<{
  field: keyof ExactParamsJson
  label: string
  fixed?: boolean
  important?: boolean
}> = [
  { field: 'trustedSeeds', label: 'Trusted accounts', important: true },
  { field: 'trustShareFp', label: 'Starting share', fixed: true },
  { field: 'trustMultiplierFp', label: 'Trusted-account boost', fixed: true },
  { field: 'trustDecayFp', label: 'Distance decay', fixed: true },
  { field: 'dampingFp', label: 'Damping', fixed: true },
  { field: 'minWeightFp', label: 'Minimum vouch weight', fixed: true },
  { field: 'maxWeightFp', label: 'Maximum vouch weight', fixed: true },
  { field: 'totalPool', label: 'Points pool' },
  { field: 'toleranceFp', label: 'Convergence tolerance', fixed: true },
  { field: 'maxIterations', label: 'Maximum iterations' },
]

const displayValue = (
  json: ExactParamsJson,
  field: keyof ExactParamsJson,
  fixed = false
) => {
  const value = json[field]
  if (Array.isArray(value)) return value.join(', ')
  return fixed ? formatFixed(BigInt(value as string)) : String(value)
}

export const diffParams = (before: Params, after: Params): ParamsDiff[] => {
  const a = paramsToJson(before)
  const b = paramsToJson(after)
  return DISPLAY_FIELDS.flatMap(({ field, label, fixed, important }) => {
    const beforeValue = displayValue(a, field, fixed)
    const afterValue = displayValue(b, field, fixed)
    return beforeValue === afterValue
      ? []
      : [{ field, label, before: beforeValue, after: afterValue, important }]
  })
}

export type ParameterAction = {
  target: Address
  value: '0'
  data: Hex
  operation: 0
  description: string
  contractName: 'SignerSyncZkModule' | 'TrustGraphParamsController'
  functionSignature: 'setParamsHash(bytes32)' | 'updateParams(Params,string)'
}

/** One canonical bundle for direct, Safe-governance, export, and timelock routes. */
export const buildParameterActions = ({
  controller,
  proposed,
  evidenceURI,
  signerCompanion,
}: {
  controller: Address
  proposed: Params
  evidenceURI: string
  signerCompanion?: Address
}): ParameterAction[] => {
  const proposedHash = paramsHash(proposed)
  const actions: ParameterAction[] = []
  if (signerCompanion) {
    actions.push({
      target: signerCompanion,
      value: '0',
      data: encodeFunctionData({
        abi: signerParamsAbi,
        functionName: 'setParamsHash',
        args: [proposedHash],
      }),
      operation: 0,
      description: `Set the signer-sync companion to the proposed scoring hash ${proposedHash}`,
      contractName: 'SignerSyncZkModule',
      functionSignature: 'setParamsHash(bytes32)',
    })
  }
  actions.push({
    target: controller,
    value: '0',
    data: encodeFunctionData({
      abi: trustGraphParamsControllerAbi,
      functionName: 'updateParams',
      args: [paramsToContract(proposed), evidenceURI],
    }),
    operation: 0,
    description: `Publish the complete scoring configuration as the next parameter version ${proposedHash}`,
    contractName: 'TrustGraphParamsController',
    functionSignature: 'updateParams(Params,string)',
  })
  return actions
}

/** Decode only the typed controller call that the scoring workflow recognizes. */
export const decodeParameterUpdateAction = (
  data: string
): { proposed: Params; proposedHash: Hex; evidenceURI: string } | null => {
  if (!data.startsWith('0x')) return null
  try {
    const decoded = decodeFunctionData({
      abi: trustGraphParamsControllerAbi,
      data: data as Hex,
    })
    if (decoded.functionName !== 'updateParams' || !decoded.args) return null
    const [tuple, evidenceURI] = decoded.args
    const proposed = paramsFromChain(tuple)
    return {
      proposed,
      proposedHash: paramsHash(proposed),
      evidenceURI,
    }
  } catch {
    return null
  }
}

/** Decode the companion call that binds signer selection to a scoring version. */
export const decodeSignerParamsHashAction = (data: string): Hex | null => {
  if (!data.startsWith('0x')) return null
  try {
    const decoded = decodeFunctionData({
      abi: signerParamsAbi,
      data: data as Hex,
    })
    if (decoded.functionName !== 'setParamsHash' || !decoded.args) return null
    return decoded.args[0]
  } catch {
    return null
  }
}

export const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as Hex
