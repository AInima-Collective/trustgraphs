import { concat, encodeAbiParameters, keccak256, stringToHex, type Hex } from 'viem'

import {
  MAX_SOURCE_AGE_BLOCKS,
  U128_MAX,
  U64_MAX,
  V1_RESEARCH_BOUNDS,
  WEIGHT_SCALE,
  canonicalScoreBlob,
  decodeCanonicalScoreBlob,
  hamilton,
  outputRoot,
  rawCidForSha256,
  sha256Hex,
  cidStringDigest,
  type CompositionBounds,
} from './reference'

export const COMPOSITION_VERSION_V2 = 2

export const COMPOSE_PROGRAM_ID = keccak256(stringToHex('trust-compose'))
export const TRUST_GRAPH_PROGRAM_ID = keccak256(stringToHex('trust-graph'))
export const WEIGHTED_TRUST_GRAPH_PROGRAM_ID = keccak256(
  stringToHex('trust-graph-weighted')
)
export const TRUST_GRAPH_OUTPUT_DOMAIN = keccak256(
  stringToHex('trustgraphs.output.trust-graph-account.v1')
)
export const WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN = keccak256(
  stringToHex('trustgraphs.output.weighted-trust-graph-account.v1')
)

/**
 * The one closed V2 compatibility class: tag, shared key domain, shared output
 * kind, then the standard and weighted program/output-domain pairs, in that
 * normative order.
 */
export const SOURCE_COMPATIBILITY_CLASS_V1 = keccak256(
  encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
    ],
    [
      keccak256(stringToHex('trust-compose.source-compatibility.v1')),
      keccak256(stringToHex('eip155-address')),
      keccak256(stringToHex('allocation')),
      TRUST_GRAPH_PROGRAM_ID,
      TRUST_GRAPH_OUTPUT_DOMAIN,
      WEIGHTED_TRUST_GRAPH_PROGRAM_ID,
      WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN,
    ]
  )
)

/** Exact admitted program → source-output-domain mapping. Nothing else passes. */
export const ADMITTED_PAIRS: ReadonlyMap<Hex, Hex> = new Map([
  [TRUST_GRAPH_PROGRAM_ID, TRUST_GRAPH_OUTPUT_DOMAIN],
  [WEIGHTED_TRUST_GRAPH_PROGRAM_ID, WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN],
])

export type CapturedSourceV2 = {
  sourceId: Hex
  snapshot: Hex
  familyId: Hex
  programId: Hex
  sourceOutputDomain: Hex
  stateIndex: bigint
  freezeBlock: bigint
  weight: bigint
  maxAgeBlocks: bigint
  outputRoot: Hex
  blobSha256: Hex
  cid: string
  totalValue: bigint
  /** Exact canonical source bytes frozen by the source state. */
  blob: string
  required: true
}

export type CompositionPolicyV2 = {
  version: 2
  chainId: bigint
  captureBlock: bigint
  scopeHash: Hex
  identityDomain: 'eip155-address'
  outputKind: 'allocation'
  sourceCompatibilityClass: Hex
  weightScale: bigint
  outputPool: bigint
  bounds: CompositionBounds
  sources: CapturedSourceV2[]
}

export type SourceAllocationV2 = {
  sourceId: Hex
  quota: bigint
  allocations: Array<{ account: Hex; value: bigint }>
}

export type CompositionResultV2 = {
  manifestSha256: Hex
  sourceAllocations: SourceAllocationV2[]
  output: Array<{ account: Hex; value: bigint }>
  outputBlob: string
  outputBlobSha256: Hex
  outputCid: string
  outputRoot: Hex
  totalValue: bigint
}

export class CompositionV2Error extends Error {}

const fail = (message: string): never => {
  throw new CompositionV2Error(message)
}

const assertHexBytes = (value: string, bytes: number, label: string): Hex => {
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(value)) {
    fail(`${label} must be lowercase ${bytes}-byte hex`)
  }
  return value as Hex
}

const assertU64 = (value: bigint, label: string) => {
  if (value < 0n || value > U64_MAX) fail(`${label} exceeds uint64`)
}

const assertU128 = (value: bigint, label: string) => {
  if (value < 0n || value > U128_MAX) fail(`${label} exceeds uint128`)
}

const bytesOfHex = (value: Hex) => Buffer.from(value.slice(2), 'hex')

const compareCanonicalKey = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0

const u64be = (value: bigint) => {
  assertU64(value, 'manifest uint64')
  const out = Buffer.alloc(8)
  out.writeBigUInt64BE(value)
  return out
}

const u128be = (value: bigint) => {
  assertU128(value, 'manifest uint128')
  const out = Buffer.alloc(16)
  out.writeBigUInt64BE(value >> 64n, 0)
  out.writeBigUInt64BE(value & U64_MAX, 8)
  return out
}

const hashPair = (left: Hex, right: Hex): Hex =>
  keccak256(concat(left <= right ? [left, right] : [right, left]))

type PolicySourceV2 = Pick<
  CapturedSourceV2,
  | 'sourceId'
  | 'snapshot'
  | 'familyId'
  | 'programId'
  | 'sourceOutputDomain'
  | 'weight'
  | 'maxAgeBlocks'
  | 'required'
>

export const sourcePolicyLeafV2 = (source: PolicySourceV2): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'uint8' },
      ],
      [
        source.sourceId,
        source.snapshot,
        source.familyId,
        source.programId,
        source.sourceOutputDomain,
        source.weight,
        source.maxAgeBlocks,
        source.required ? 1 : 0,
      ]
    )
  )

/** Source-id-order leaves, sorted-pair parents, and odd-node promotion. */
export const sourcePolicyRootV2 = (sources: PolicySourceV2[]): Hex => {
  let level = [...sources]
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
    .map(sourcePolicyLeafV2)
  while (level.length > 1) {
    const next: Hex[] = []
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!
      const right = level[index + 1]
      next.push(right ? hashPair(left, right) : left)
    }
    level = next
  }
  return level[0] ?? (`0x${'00'.repeat(32)}` as Hex)
}

/** Compact static TGCP V2: 15-byte header plus 165-byte records. */
export const canonicalPolicyManifestV2 = (
  chainId: bigint,
  sources: PolicySourceV2[]
) => {
  const ordered = [...sources].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId)
  )
  return Buffer.concat([
    Buffer.from('TGCP'),
    Buffer.from([0, COMPOSITION_VERSION_V2]),
    u64be(chainId),
    Buffer.from([ordered.length]),
    ...ordered.map((source) =>
      Buffer.concat([
        bytesOfHex(source.sourceId),
        bytesOfHex(source.snapshot),
        bytesOfHex(source.familyId),
        bytesOfHex(source.programId),
        bytesOfHex(source.sourceOutputDomain),
        u64be(source.weight),
        u64be(source.maxAgeBlocks),
        Buffer.from([source.required ? 1 : 0]),
      ])
    ),
  ])
}

/** Captured-state TGCM V2: 23-byte header plus 293-byte records. */
export const canonicalManifestV2 = (
  policy: Pick<CompositionPolicyV2, 'chainId' | 'captureBlock'>,
  sources: CapturedSourceV2[]
) => {
  const ordered = [...sources].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId)
  )
  const header = Buffer.concat([
    Buffer.from('TGCM'),
    Buffer.from([0, COMPOSITION_VERSION_V2]),
    u64be(policy.chainId),
    u64be(policy.captureBlock),
    Buffer.from([ordered.length]),
  ])
  const records = ordered.map((source) =>
    Buffer.concat([
      bytesOfHex(source.sourceId),
      bytesOfHex(source.snapshot),
      bytesOfHex(source.familyId),
      bytesOfHex(source.programId),
      bytesOfHex(source.sourceOutputDomain),
      u64be(source.stateIndex),
      u64be(source.freezeBlock),
      bytesOfHex(source.outputRoot),
      bytesOfHex(source.blobSha256),
      bytesOfHex(cidStringDigest(source.cid)),
      u128be(source.totalValue),
      u64be(source.weight),
      u64be(source.maxAgeBlocks),
      Buffer.from([source.required ? 1 : 0]),
    ])
  )
  return Buffer.concat([header, ...records])
}

const validateBounds = (bounds: CompositionBounds) => {
  const values = Object.values(bounds)
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    fail('composition bounds must be positive safe integers')
  }
  if (bounds.maxSources > 255) fail('maxSources exceeds manifest uint8')
  for (const [key, ceiling] of Object.entries(V1_RESEARCH_BOUNDS)) {
    if (bounds[key as keyof CompositionBounds] > ceiling) {
      fail(`${key} exceeds the V1 ceiling`)
    }
  }
  if (
    bounds.maxEntriesPerSource > bounds.maxAggregateEntries ||
    bounds.maxUnionAccounts > bounds.maxAggregateEntries
  ) {
    fail('per-source/union bounds cannot exceed the aggregate entry bound')
  }
}

/**
 * Class and pair validation. Runs on the static policy fields only, so every
 * unadmitted program/output pair fails before any source blob is fetched or
 * decoded.
 */
export const validateAdmittedPair = (
  source: Pick<PolicySourceV2, 'programId' | 'sourceOutputDomain'>,
  index: number
) => {
  if (source.programId === COMPOSE_PROGRAM_ID) {
    fail(`source ${index} is a composite source`)
  }
  const domain = ADMITTED_PAIRS.get(source.programId)
  if (!domain) {
    fail(`source ${index} program is not in the compatibility class`)
  }
  if (domain !== source.sourceOutputDomain) {
    fail(`source ${index} output domain does not match its program`)
  }
}

const validatePolicy = (policy: CompositionPolicyV2) => {
  if (policy.version !== COMPOSITION_VERSION_V2) {
    fail('unsupported policy version')
  }
  assertU64(policy.chainId, 'chainId')
  if (policy.chainId === 0n) fail('chainId must be nonzero')
  assertU64(policy.captureBlock, 'captureBlock')
  assertU128(policy.outputPool, 'outputPool')
  if (policy.outputPool === 0n) fail('outputPool must be positive')
  if (policy.weightScale !== WEIGHT_SCALE) fail('unsupported weight scale')
  assertHexBytes(policy.scopeHash, 32, 'scopeHash')
  if (policy.sourceCompatibilityClass !== SOURCE_COMPATIBILITY_CLASS_V1) {
    fail('unsupported source compatibility class')
  }
  if (
    policy.identityDomain !== 'eip155-address' ||
    policy.outputKind !== 'allocation'
  ) {
    fail('unsupported identity domain or output kind')
  }
  validateBounds(policy.bounds)
  if (
    policy.sources.length < 2 ||
    policy.sources.length > policy.bounds.maxSources
  ) {
    fail('source count is outside V2 bounds')
  }
  ;[...policy.sources]
    .sort((left, right) => compareCanonicalKey(left.sourceId, right.sourceId))
    .forEach((source, index) => validateAdmittedPair(source, index))
}

/**
 * Reference V2 mixed composition. This code is research evidence, not imported
 * by any production path. The blend arithmetic is deliberately identical to V1;
 * only source admission and the commitments differ.
 */
export const composeV2 = (
  policy: CompositionPolicyV2
): CompositionResultV2 => {
  validatePolicy(policy)
  const sources = [...policy.sources].sort((left, right) =>
    compareCanonicalKey(left.sourceId, right.sourceId)
  )
  const ids = new Set<string>()
  const snapshots = new Set<string>()
  let aggregateEntries = 0
  let aggregateBlobBytes = 0

  const validated = sources.map((source, index) => {
    assertHexBytes(source.sourceId, 32, 'sourceId')
    assertHexBytes(source.snapshot, 20, 'snapshot')
    assertHexBytes(source.familyId, 32, 'familyId')
    assertHexBytes(source.programId, 32, 'programId')
    assertHexBytes(source.sourceOutputDomain, 32, 'sourceOutputDomain')
    assertHexBytes(source.outputRoot, 32, 'outputRoot')
    assertHexBytes(source.blobSha256, 32, 'blobSha256')
    if (ids.has(source.sourceId)) fail('duplicate sourceId')
    if (snapshots.has(source.snapshot)) fail('duplicate source snapshot')
    ids.add(source.sourceId)
    snapshots.add(source.snapshot)
    if (!source.required) fail('optional sources are unsupported in V2')
    validateAdmittedPair(source, index)
    assertU64(source.stateIndex, 'stateIndex')
    assertU64(source.freezeBlock, 'freezeBlock')
    assertU64(source.maxAgeBlocks, 'maxAgeBlocks')
    assertU64(source.weight, 'source weight')
    assertU128(source.totalValue, 'source totalValue')
    if (source.weight === 0n || source.totalValue === 0n) {
      fail('source weight and totalValue must be positive')
    }
    if (
      source.maxAgeBlocks === 0n ||
      source.maxAgeBlocks > MAX_SOURCE_AGE_BLOCKS
    ) {
      fail('source maxAgeBlocks is outside V2 bounds')
    }
    if (
      source.freezeBlock > policy.captureBlock ||
      policy.captureBlock - source.freezeBlock > source.maxAgeBlocks
    ) {
      fail(`source ${source.sourceId} is stale at capture`)
    }
    const blobBytes = Buffer.byteLength(source.blob)
    aggregateBlobBytes += blobBytes
    if (sha256Hex(source.blob) !== source.blobSha256) {
      fail(`source ${source.sourceId} blob sha256 mismatch`)
    }
    if (rawCidForSha256(source.blobSha256) !== source.cid) {
      fail(`source ${source.sourceId} CID mismatch`)
    }
    const entries = decodeCanonicalScoreBlob(source.blob)
    if (entries.length > policy.bounds.maxEntriesPerSource) {
      fail(`source ${source.sourceId} exceeds the per-source entry bound`)
    }
    aggregateEntries += entries.length
    const total = entries.reduce((sum, entry) => sum + entry.value, 0n)
    if (total !== source.totalValue) {
      fail(`source ${source.sourceId} totalValue mismatch`)
    }
    if (outputRoot(entries) !== source.outputRoot) {
      fail(`source ${source.sourceId} output root mismatch`)
    }
    return { ...source, entries }
  })

  if (aggregateEntries > policy.bounds.maxAggregateEntries) {
    fail('aggregate source entries exceed the policy bound')
  }
  if (aggregateBlobBytes > policy.bounds.maxAggregateBlobBytes) {
    fail('aggregate source bytes exceed the policy bound')
  }
  const union = new Set(
    validated.flatMap((source) => source.entries.map((e) => e.account))
  )
  if (union.size > policy.bounds.maxUnionAccounts) {
    fail('union account count exceeds the policy bound')
  }

  const quotas = hamilton(
    policy.outputPool,
    policy.weightScale,
    validated.map((source) => ({
      key: source.sourceId,
      value: source.weight,
      data: source,
    }))
  )
  if (quotas.some((source) => source.allocation === 0n)) {
    fail('every required source must receive at least one output point')
  }
  const sourceAllocations = quotas.map(
    ({ data: source, allocation: quota }) => {
      const allocations = hamilton(
        quota,
        source.totalValue,
        source.entries.map((entry) => ({
          key: entry.account,
          value: entry.value,
          data: entry.account,
        }))
      )
        .filter((entry) => entry.allocation > 0n)
        .map((entry) => ({ account: entry.data, value: entry.allocation }))
      return { sourceId: source.sourceId, quota, allocations }
    }
  )

  const combined = new Map<Hex, bigint>()
  for (const source of sourceAllocations) {
    for (const entry of source.allocations) {
      combined.set(
        entry.account,
        (combined.get(entry.account) ?? 0n) + entry.value
      )
    }
  }
  const output = [...combined]
    .map(([account, value]) => ({ account, value }))
    .filter((entry) => entry.value > 0n)
    .sort((left, right) => compareCanonicalKey(left.account, right.account))
  const totalValue = output.reduce((sum, entry) => sum + entry.value, 0n)
  if (totalValue !== policy.outputPool) {
    fail('composite output does not conserve its pool')
  }
  const outputBlob = canonicalScoreBlob(output)
  const outputBlobSha256 = sha256Hex(outputBlob)
  return {
    manifestSha256: sha256Hex(canonicalManifestV2(policy, validated)),
    sourceAllocations,
    output,
    outputBlob,
    outputBlobSha256,
    outputCid: rawCidForSha256(outputBlobSha256),
    outputRoot: outputRoot(output),
    totalValue,
  }
}

export const sourceFromBlobV2 = (
  source: Omit<
    CapturedSourceV2,
    'blobSha256' | 'cid' | 'outputRoot' | 'totalValue'
  >
): CapturedSourceV2 => {
  const entries = decodeCanonicalScoreBlob(source.blob)
  const blobSha256 = sha256Hex(source.blob)
  return {
    ...source,
    blobSha256,
    cid: rawCidForSha256(blobSha256),
    outputRoot: outputRoot(entries),
    totalValue: entries.reduce((sum, entry) => sum + entry.value, 0n),
  }
}
