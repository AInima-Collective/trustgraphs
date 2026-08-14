import { createHash } from 'node:crypto'

import {
  concat,
  encodeAbiParameters,
  isAddress,
  keccak256,
  stringToHex,
  type Hex,
} from 'viem'

export const COMPOSITION_VERSION = 1
export const WEIGHT_SCALE = 1_000_000_000_000_000_000n
export const U64_MAX = (1n << 64n) - 1n
export const U128_MAX = (1n << 128n) - 1n
export const MAX_SOURCE_AGE_BLOCKS = 500_000n

export type CompositionBounds = {
  maxSources: number
  maxEntriesPerSource: number
  maxAggregateEntries: number
  maxUnionAccounts: number
  maxAggregateBlobBytes: number
}

export const V1_RESEARCH_BOUNDS: CompositionBounds = {
  maxSources: 8,
  maxEntriesPerSource: 4_096,
  maxAggregateEntries: 8_192,
  maxUnionAccounts: 8_192,
  maxAggregateBlobBytes: 1024 * 1024,
}

export type CapturedSource = {
  sourceId: Hex
  snapshot: Hex
  familyId: Hex
  programId: Hex
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

export type CompositionPolicy = {
  version: 1
  chainId: bigint
  captureBlock: bigint
  scopeHash: Hex
  identityDomain: 'eip155-address'
  outputKind: 'allocation'
  admittedProgramId: Hex
  weightScale: bigint
  outputPool: bigint
  bounds: CompositionBounds
  sources: CapturedSource[]
}

export type SourceAllocation = {
  sourceId: Hex
  quota: bigint
  allocations: Array<{ account: Hex; value: bigint }>
}

export type CompositionResult = {
  manifestSha256: Hex
  sourceAllocations: SourceAllocation[]
  output: Array<{ account: Hex; value: bigint }>
  outputBlob: string
  outputBlobSha256: Hex
  outputCid: string
  outputRoot: Hex
  totalValue: bigint
}

export class CompositionError extends Error {}

const fail = (message: string): never => {
  throw new CompositionError(message)
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

export const sha256Hex = (bytes: string | Uint8Array): Hex =>
  `0x${createHash('sha256').update(bytes).digest('hex')}`

const base32LowerNoPad = (bytes: Uint8Array) => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let accumulator = 0
  let bits = 0
  let output = ''
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += alphabet[(accumulator >> bits) & 31]
    }
    // Retain only pending bits so JavaScript's signed 32-bit bitwise operations stay bounded.
    accumulator &= (1 << bits) - 1
  }
  if (bits > 0) output += alphabet[(accumulator << (5 - bits)) & 31]
  return output
}

export const rawCidForSha256 = (digest: Hex) => {
  assertHexBytes(digest, 32, 'sha256 digest')
  return `b${base32LowerNoPad(
    Uint8Array.from([0x01, 0x55, 0x12, 0x20, ...bytesOfHex(digest)])
  )}`
}

export const cidStringDigest = (cid: string): Hex => keccak256(stringToHex(cid))

const canonicalPositiveDecimal = (value: unknown, label: string) => {
  if (typeof value !== 'string') {
    fail(`${label} must be a canonical positive decimal string`)
  }
  const text = value as string
  if (!/^[1-9][0-9]*$/.test(text)) {
    fail(`${label} must be a canonical positive decimal string`)
  }
  const parsed = BigInt(text)
  assertU128(parsed, label)
  return parsed
}

export const canonicalScoreBlob = (
  entries: Array<{ account: Hex; value: bigint }>
) =>
  `{${entries
    .map(({ account, value }) => `"${account}":"${value.toString()}"`)
    .join(',')}}`

/** Strictly decode the complete canonical address/value source blob. */
export const decodeCanonicalScoreBlob = (blob: string) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(blob)
  } catch {
    return fail('source blob is not JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('source blob must be an object')
  }
  const entries = Object.entries(parsed as Record<string, unknown>)
    .map(([account, value]) => {
      if (
        !/^0x[0-9a-f]{40}$/.test(account) ||
        !isAddress(account, { strict: false })
      ) {
        return fail('source account must be a lowercase EVM address')
      }
      return {
        account: account as Hex,
        value: canonicalPositiveDecimal(value, `value for ${account}`),
      }
    })
    .sort((left, right) => compareCanonicalKey(left.account, right.account))

  if (entries.length === 0) fail('source blob must not be empty')
  if (canonicalScoreBlob(entries) !== blob) {
    fail('source blob is not the exact canonical encoding')
  }
  return entries
}

export const outputLeaf = (account: Hex, value: bigint): Hex => {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [account, value]
    )
  )
  return keccak256(inner)
}

const hashPair = (left: Hex, right: Hex): Hex =>
  keccak256(concat(left <= right ? [left, right] : [right, left]))

/** OpenZeppelin StandardMerkleTree root, matching the existing address/value output. */
export const outputRoot = (
  entries: Array<{ account: Hex; value: bigint }>
): Hex => {
  const leaves = entries.map(({ account, value }) => outputLeaf(account, value))
  if (leaves.length === 0) return `0x${'0'.repeat(64)}` as Hex
  leaves.sort()
  if (leaves.length === 1) return leaves[0]!
  const tree = new Array<Hex>(2 * leaves.length - 1)
  for (const [index, leaf] of leaves.entries()) {
    tree[tree.length - 1 - index] = leaf
  }
  for (let index = leaves.length - 2; index >= 0; index--) {
    tree[index] = hashPair(tree[2 * index + 1]!, tree[2 * index + 2]!)
  }
  return tree[0]!
}

type HamiltonItem<T> = { key: string; value: bigint; data: T }

/** Exact Hamilton allocation. Equal remainders are resolved by ascending canonical key. */
export const hamilton = <T>(
  pool: bigint,
  denominator: bigint,
  items: HamiltonItem<T>[]
) => {
  if (pool < 0n || denominator <= 0n || items.length === 0) {
    return fail('invalid Hamilton inputs')
  }
  const valueSum = items.reduce((sum, item) => sum + item.value, 0n)
  if (valueSum !== denominator || items.some((item) => item.value <= 0n)) {
    return fail('Hamilton weights must be positive and sum to the denominator')
  }
  const apportioned = items.map((item) => {
    const numerator = pool * item.value
    return {
      ...item,
      allocation: numerator / denominator,
      remainder: numerator % denominator,
    }
  })
  let residual =
    pool - apportioned.reduce((sum, item) => sum + item.allocation, 0n)
  const order = [...apportioned].sort((left, right) =>
    left.remainder === right.remainder
      ? compareCanonicalKey(left.key, right.key)
      : left.remainder > right.remainder
        ? -1
        : 1
  )
  for (const item of order) {
    if (residual === 0n) break
    item.allocation++
    residual--
  }
  if (residual !== 0n) fail('Hamilton residual exceeds item count')
  return apportioned.sort((left, right) =>
    compareCanonicalKey(left.key, right.key)
  )
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

export const canonicalManifest = (
  policy: CompositionPolicy,
  sources: Array<
    CapturedSource & { entries: Array<{ account: Hex; value: bigint }> }
  >
) => {
  const header = Buffer.concat([
    Buffer.from('TGCM'),
    Buffer.from([0, COMPOSITION_VERSION]),
    u64be(policy.chainId),
    u64be(policy.captureBlock),
    Buffer.from([sources.length]),
  ])
  const records = sources.map((source) =>
    Buffer.concat([
      bytesOfHex(source.sourceId),
      bytesOfHex(source.snapshot),
      bytesOfHex(source.familyId),
      bytesOfHex(source.programId),
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

const validatePolicy = (policy: CompositionPolicy) => {
  if (policy.version !== COMPOSITION_VERSION) fail('unsupported policy version')
  assertU64(policy.chainId, 'chainId')
  assertU64(policy.captureBlock, 'captureBlock')
  assertU128(policy.outputPool, 'outputPool')
  if (policy.outputPool === 0n) fail('outputPool must be positive')
  if (policy.weightScale !== WEIGHT_SCALE) fail('unsupported weight scale')
  assertHexBytes(policy.scopeHash, 32, 'scopeHash')
  assertHexBytes(policy.admittedProgramId, 32, 'admittedProgramId')
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
    fail('source count is outside V1 bounds')
  }
}

/**
 * Reference V1 composition. This code is research evidence, not imported by any production path.
 */
export const compose = (policy: CompositionPolicy): CompositionResult => {
  validatePolicy(policy)
  const sources = [...policy.sources].sort((left, right) =>
    compareCanonicalKey(left.sourceId, right.sourceId)
  )
  const ids = new Set<string>()
  const snapshots = new Set<string>()
  let aggregateEntries = 0
  let aggregateBlobBytes = 0

  const validated = sources.map((source) => {
    assertHexBytes(source.sourceId, 32, 'sourceId')
    assertHexBytes(source.snapshot, 20, 'snapshot')
    assertHexBytes(source.familyId, 32, 'familyId')
    assertHexBytes(source.programId, 32, 'programId')
    assertHexBytes(source.outputRoot, 32, 'outputRoot')
    assertHexBytes(source.blobSha256, 32, 'blobSha256')
    if (ids.has(source.sourceId)) fail('duplicate sourceId')
    if (snapshots.has(source.snapshot)) fail('duplicate source snapshot')
    ids.add(source.sourceId)
    snapshots.add(source.snapshot)
    if (!source.required) fail('optional sources are unsupported in V1')
    if (source.programId !== policy.admittedProgramId) {
      fail('source program is not admitted')
    }
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
      fail('source maxAgeBlocks is outside V1 bounds')
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
  if (totalValue !== policy.outputPool)
    fail('composite output does not conserve its pool')
  const outputBlob = canonicalScoreBlob(output)
  const outputBlobSha256 = sha256Hex(outputBlob)
  return {
    manifestSha256: sha256Hex(canonicalManifest(policy, validated)),
    sourceAllocations,
    output,
    outputBlob,
    outputBlobSha256,
    outputCid: rawCidForSha256(outputBlobSha256),
    outputRoot: outputRoot(output),
    totalValue,
  }
}

export const sourceFromBlob = (
  source: Omit<
    CapturedSource,
    'blobSha256' | 'cid' | 'outputRoot' | 'totalValue'
  >
): CapturedSource => {
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
