//! Browser-safe, byte-exact mirror of `composition-core` (V1) and `composition-core-v2`.
//!
//! This module computes previews only from complete, authenticated source distributions. It never
//! consumes raw graph edges and never treats a source's raw point scale as influence. V2 admits
//! one closed compatibility class — the standard and weighted TrustGraph program/output-domain
//! pairs — so a single composition can blend both without relabelling either source.

import {
  type Address,
  type Hex,
  concat,
  encodeAbiParameters,
  keccak256,
  sha256,
  stringToHex,
  toHex,
} from 'viem'

import {
  canonicalBlob,
  cidV1Raw,
  digestToHex,
  sha256Utf8,
} from '../pagerank/cid'
import { hashPair, merkleRoot, outputLeaf } from '../pagerank/merkle'
import { ZERO_ADDRESS, ZERO_HASH, cmpBig, cmpHex } from '../pagerank/words'

export const COMPOSITION_VERSION = 1
export const WEIGHT_SCALE = 1_000_000_000_000_000_000n
export const COMPOSITION_PROGRAM_ID = keccak256(stringToHex('trust-compose'))
export const COMPOSITION_IDENTITY_DOMAIN = keccak256(
  stringToHex('eip155-address')
)
export const COMPOSITION_OUTPUT_KIND = keccak256(stringToHex('allocation'))
export const COMPOSITION_OUTPUT_DOMAIN = keccak256(
  stringToHex('trustgraphs.output.trust-compose-account.v1')
)
export const DEFAULT_COMPOSITION_SCOPE = keccak256(
  stringToHex('governance-voice-allocation-v1')
)
export const MAX_SOURCE_AGE_BLOCKS = 500_000n

export const TRUST_GRAPH_SOURCE_PROGRAM_ID = keccak256(
  stringToHex('trust-graph')
)
export const WEIGHTED_TRUST_GRAPH_SOURCE_PROGRAM_ID = keccak256(
  stringToHex('trust-graph-weighted')
)
export const TRUST_GRAPH_SOURCE_OUTPUT_DOMAIN = keccak256(
  stringToHex('trustgraphs.output.trust-graph-account.v1')
)
export const WEIGHTED_TRUST_GRAPH_SOURCE_OUTPUT_DOMAIN = keccak256(
  stringToHex('trustgraphs.output.weighted-trust-graph-account.v1')
)

/**
 * The one closed V2 compatibility class: class tag, shared key domain, shared
 * output kind, then the standard and weighted program/output-domain pairs, in
 * that normative order. Adding a pair requires another reviewed class and a
 * new params/guest version.
 */
export const COMPOSITION_SOURCE_COMPATIBILITY_CLASS = keccak256(
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
      COMPOSITION_IDENTITY_DOMAIN,
      COMPOSITION_OUTPUT_KIND,
      TRUST_GRAPH_SOURCE_PROGRAM_ID,
      TRUST_GRAPH_SOURCE_OUTPUT_DOMAIN,
      WEIGHTED_TRUST_GRAPH_SOURCE_PROGRAM_ID,
      WEIGHTED_TRUST_GRAPH_SOURCE_OUTPUT_DOMAIN,
    ]
  )
)

/** The sole output domain a source program is admitted with under the V2 class. */
export const admittedSourceOutputDomain = (programId: Hex): Hex | null => {
  const lowered = programId.toLowerCase()
  if (lowered === TRUST_GRAPH_SOURCE_PROGRAM_ID)
    return TRUST_GRAPH_SOURCE_OUTPUT_DOMAIN
  if (lowered === WEIGHTED_TRUST_GRAPH_SOURCE_PROGRAM_ID)
    return WEIGHTED_TRUST_GRAPH_SOURCE_OUTPUT_DOMAIN
  return null
}

export type CompositionParamsVersion = 1 | 2

export type CompositionBounds = {
  maxSources: number
  maxEntriesPerSource: number
  maxAggregateEntries: number
  maxUnionAccounts: number
  maxAggregateBlobBytes: number
}

export const V1_COMPOSITION_BOUNDS: CompositionBounds = {
  maxSources: 8,
  maxEntriesPerSource: 4_096,
  maxAggregateEntries: 8_192,
  maxUnionAccounts: 8_192,
  maxAggregateBlobBytes: 1024 * 1024,
}

export type CompositionEntry = {
  account: Address
  value: bigint
}

export type CompositionSource = {
  instanceId: Hex
  name: string
  chainId: bigint
  sourceId: Hex
  snapshot: Address
  familyId: Hex
  programId: Hex
  controller: Address
  registry: Address
  verifier: Address
  paramsHash: Hex
  adapter: Address | null
  deploymentProvenance: Hex
  stateIndex: bigint
  checkpointId: bigint
  acceptedAtBlock: bigint
  freezeBlock: bigint
  outputRoot: Hex
  blobSha256: Hex
  cid: string
  totalValue: bigint
  weight: bigint
  maxAgeBlocks: bigint
  entries: CompositionEntry[]
  available: boolean
  availabilityError: string | null
}

export type CompositionConfig = {
  chainId: bigint
  captureBlock: bigint
  scopeHash: Hex
  /** The params generation: 1 admits one program; 2 admits the closed mixed class. */
  paramsVersion: CompositionParamsVersion
  /** V1 only. A V2 policy admits the class, never a single relabelled program. */
  admittedProgramId: Hex | null
  outputPool: bigint
  bounds: CompositionBounds
  sources: CompositionSource[]
}

export type SourceAttribution = {
  sourceId: Hex
  account: Address
  exactValue: bigint
  idealNumerator: bigint
  idealDenominator: bigint
  roundingDeltaNumerator: bigint
}

export type SourceAllocation = {
  sourceId: Hex
  quota: bigint
  entries: CompositionEntry[]
}

export type WorkShape = {
  sourceCount: number
  aggregateEntries: number
  unionAccounts: number
  aggregateBlobBytes: number
  band: 1 | 2 | 3 | 4
  measuredCycles: number
}

export type PairwiseMetric = {
  left: Hex
  right: Hex
  overlapAccounts: number
  unionAccounts: number
  overlapRatio: number
  correlation: number
  disagreement: number
}

export type LeaveOneOutMetric = {
  omittedSourceId: Hex
  disagreement: number
  changedTopAccounts: Address[]
  topAccounts: Address[]
}

export type CompositionMetrics = {
  pairwise: PairwiseMetric[]
  leaveOneOut: LeaveOneOutMetric[]
  accountsInEverySource: number
  accountsInOneSource: number
  supportCoverage: number
  largestShare: number
  top10Share: number
  hhi: number
}

export type CompositionPreview = {
  policyManifest: Hex
  policyManifestSha256: Hex
  sourcePolicyRoot: Hex
  captureManifest: Hex
  captureManifestSha256: Hex
  sourceAllocations: SourceAllocation[]
  attribution: SourceAttribution[]
  output: CompositionEntry[]
  outputBlob: string
  outputBlobSha256: Hex
  outputCid: string
  outputRoot: Hex
  totalValue: bigint
  work: WorkShape
  metrics: CompositionMetrics
}

export class CompositionPreviewError extends Error {}

const fail = (message: string): never => {
  throw new CompositionPreviewError(message)
}

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength

const requireUint = (value: bigint, bits: number, label: string) => {
  if (value < 0n || value >= 1n << BigInt(bits)) {
    fail(`${label} exceeds uint${bits}`)
  }
}

const canonicalAddress = (value: Hex): Address => value.toLowerCase() as Address

const canonicalWord = (value: Hex, label: string): Hex => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) fail(`${label} must be bytes32`)
  return value.toLowerCase() as Hex
}

const orderedEntries = (entries: CompositionEntry[]) => {
  const result = entries
    .map((entry) => ({
      account: canonicalAddress(entry.account),
      value: entry.value,
    }))
    .sort((left, right) => cmpHex(left.account, right.account))
  for (let index = 0; index < result.length; index++) {
    const entry = result[index]!
    if (entry.account === ZERO_ADDRESS || entry.value <= 0n) {
      fail('source entries require nonzero addresses and positive values')
    }
    if (index > 0 && result[index - 1]!.account === entry.account) {
      fail(`duplicate source account ${entry.account}`)
    }
  }
  if (result.length === 0) fail('source output is empty')
  return result
}

export const canonicalCompositionBlob = (entries: CompositionEntry[]) =>
  canonicalBlob(
    orderedEntries(entries).map(({ account, value }) => [account, value])
  )

export const compositionOutputRoot = (entries: CompositionEntry[]): Hex =>
  merkleRoot(
    orderedEntries(entries).map(({ account, value }) =>
      outputLeaf(account, value)
    )
  )

export const compositionSourceId = (instanceId: Hex, snapshot: Address): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }],
      [canonicalWord(instanceId, 'instanceId'), canonicalAddress(snapshot)]
    )
  )

/** A visible default only. Governance must review and may replace this publisher-family label. */
export const suggestedFamilyId = (programId: Hex, controller: Address): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }],
      [canonicalWord(programId, 'programId'), canonicalAddress(controller)]
    )
  )

export const sourceReviewPacket = (
  source: Pick<
    CompositionSource,
    | 'chainId'
    | 'instanceId'
    | 'snapshot'
    | 'programId'
    | 'controller'
    | 'registry'
    | 'verifier'
    | 'paramsHash'
  >
) =>
  JSON.stringify({
    schema: 'trustgraphs-composition-source-review-v1',
    chainId: source.chainId.toString(),
    instanceId: source.instanceId.toLowerCase(),
    snapshot: source.snapshot.toLowerCase(),
    programId: source.programId.toLowerCase(),
    controller: source.controller.toLowerCase(),
    registry: source.registry.toLowerCase(),
    verifier: source.verifier.toLowerCase(),
    paramsHash: source.paramsHash.toLowerCase(),
  })

export const sourceReviewDigest = (
  source: Parameters<typeof sourceReviewPacket>[0]
): Hex => sha256(stringToHex(sourceReviewPacket(source)))

export const exactEqualWeights = (sourceIds: Hex[]): Map<Hex, bigint> => {
  if (sourceIds.length < 2 || sourceIds.length > 8) {
    fail('equal weights require 2–8 sources')
  }
  const ordered = [...sourceIds]
    .map((sourceId) => canonicalWord(sourceId, 'sourceId'))
    .sort(cmpHex)
  if (new Set(ordered).size !== ordered.length) fail('duplicate sourceId')
  const denominator = BigInt(ordered.length)
  const base = WEIGHT_SCALE / denominator
  let remainder = WEIGHT_SCALE - base * denominator
  return new Map(
    ordered.map((sourceId) => {
      const weight = base + (remainder > 0n ? 1n : 0n)
      if (remainder > 0n) remainder--
      return [sourceId, weight]
    })
  )
}

/** Parse a percentage into the exact 1e18 policy scale (100% = 1e18). */
export const parseWeightPercent = (raw: string): bigint => {
  const match = raw.trim().match(/^(\d{1,3})(?:\.(\d{1,16}))?$/)
  if (!match) {
    throw new CompositionPreviewError(
      'weight must be a percentage with at most 16 decimals'
    )
  }
  const whole = BigInt(match[1]!)
  const fraction = BigInt((match[2] ?? '').padEnd(16, '0') || '0')
  const value = whole * 10n ** 16n + fraction
  if (value <= 0n || value > WEIGHT_SCALE) {
    fail('every configured weight must be greater than 0% and at most 100%')
  }
  return value
}

export const formatWeightPercent = (weight: bigint): string => {
  requireUint(weight, 64, 'weight')
  const whole = weight / 10n ** 16n
  const fraction = (weight % 10n ** 16n)
    .toString()
    .padStart(16, '0')
    .replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

type HamiltonRow<T> = {
  key: Hex
  numerator: bigint
  data: T
}

export const hamilton = <T>(
  pool: bigint,
  denominator: bigint,
  rows: HamiltonRow<T>[]
) => {
  if (pool < 0n || denominator <= 0n || rows.length === 0) {
    return fail('invalid Hamilton inputs')
  }
  const seen = new Set<string>()
  let sum = 0n
  const apportioned = rows.map((row) => {
    const key = row.key.toLowerCase() as Hex
    if (seen.has(key)) fail(`duplicate Hamilton key ${key}`)
    if (row.numerator <= 0n) fail('Hamilton numerators must be positive')
    seen.add(key)
    sum += row.numerator
    const product = pool * row.numerator
    return {
      ...row,
      key,
      allocation: product / denominator,
      remainder: product % denominator,
    }
  })
  if (sum !== denominator) fail('Hamilton denominator mismatch')
  let residual =
    pool - apportioned.reduce((total, row) => total + row.allocation, 0n)
  const remainderOrder = [...apportioned].sort((left, right) => {
    const remainder = cmpBig(right.remainder, left.remainder)
    return remainder !== 0 ? remainder : cmpHex(left.key, right.key)
  })
  for (const row of remainderOrder) {
    if (residual === 0n) break
    row.allocation++
    residual--
  }
  if (residual !== 0n) fail('Hamilton residual exceeds row count')
  return apportioned.sort((left, right) => cmpHex(left.key, right.key))
}

/** The domain a V2 record commits for this source, derived from its program — never asserted. */
const requireAdmittedDomain = (source: CompositionSource): Hex =>
  admittedSourceOutputDomain(source.programId) ??
  fail(`source ${source.name} is not in the compatibility class`)

const sourcePolicyLeaf = (
  source: CompositionSource,
  version: CompositionParamsVersion
): Hex =>
  version === 1
    ? keccak256(
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'address' },
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
            source.weight,
            source.maxAgeBlocks,
            1,
          ]
        )
      )
    : keccak256(
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
            requireAdmittedDomain(source),
            source.weight,
            source.maxAgeBlocks,
            1,
          ]
        )
      )

export const compositionPolicyRoot = (
  sources: CompositionSource[],
  version: CompositionParamsVersion = 1
): Hex => {
  let level = [...sources]
    .sort((left, right) => cmpHex(left.sourceId, right.sourceId))
    .map((source) => sourcePolicyLeaf(source, version))
  if (level.length === 0) return ZERO_HASH
  while (level.length > 1) {
    const next: Hex[] = []
    for (let index = 0; index < level.length; index += 2) {
      next.push(
        index + 1 === level.length
          ? level[index]!
          : hashPair(level[index]!, level[index + 1]!)
      )
    }
    level = next
  }
  return level[0]!
}

export const canonicalPolicyManifest = (
  chainId: bigint,
  sources: CompositionSource[],
  version: CompositionParamsVersion = 1
): Hex => {
  requireUint(chainId, 64, 'chainId')
  const ordered = [...sources].sort((left, right) =>
    cmpHex(left.sourceId, right.sourceId)
  )
  return concat([
    '0x54474350',
    toHex(version, { size: 2 }),
    toHex(chainId, { size: 8 }),
    toHex(ordered.length, { size: 1 }),
    ...ordered.flatMap((source) => [
      source.sourceId,
      source.snapshot,
      source.familyId,
      source.programId,
      ...(version === 2 ? [requireAdmittedDomain(source)] : []),
      toHex(source.weight, { size: 8 }),
      toHex(source.maxAgeBlocks, { size: 8 }),
      toHex(1, { size: 1 }),
    ]),
  ])
}

export const canonicalCaptureManifest = (
  config: CompositionConfig,
  sources: CompositionSource[]
): Hex => {
  requireUint(config.chainId, 64, 'chainId')
  requireUint(config.captureBlock, 64, 'captureBlock')
  const ordered = [...sources].sort((left, right) =>
    cmpHex(left.sourceId, right.sourceId)
  )
  return concat([
    '0x5447434d',
    toHex(config.paramsVersion, { size: 2 }),
    toHex(config.chainId, { size: 8 }),
    toHex(config.captureBlock, { size: 8 }),
    toHex(ordered.length, { size: 1 }),
    ...ordered.flatMap((source) => [
      source.sourceId,
      source.snapshot,
      source.familyId,
      source.programId,
      ...(config.paramsVersion === 2 ? [requireAdmittedDomain(source)] : []),
      toHex(source.stateIndex, { size: 8 }),
      toHex(source.freezeBlock, { size: 8 }),
      source.outputRoot,
      source.blobSha256,
      keccak256(stringToHex(source.cid)),
      toHex(source.totalValue, { size: 16 }),
      toHex(source.weight, { size: 8 }),
      toHex(source.maxAgeBlocks, { size: 8 }),
      toHex(1, { size: 1 }),
    ]),
  ])
}

export const classifyCompositionWork = (
  sourceCount: number,
  aggregateEntries: number,
  unionAccounts: number,
  aggregateBlobBytes: number
): WorkShape => {
  const band =
    sourceCount <= 2 &&
    aggregateEntries <= 128 &&
    unionAccounts <= 128 &&
    aggregateBlobBytes <= 16 * 1024
      ? 1
      : sourceCount <= 4 &&
          aggregateEntries <= 1_024 &&
          unionAccounts <= 1_024 &&
          aggregateBlobBytes <= 128 * 1024
        ? 2
        : aggregateEntries <= 4_096 &&
            unionAccounts <= 4_096 &&
            aggregateBlobBytes <= 512 * 1024
          ? 3
          : 4
  const measuredCycles = [0, 2_616_399, 24_312_132, 105_652_691, 222_311_301][
    band
  ]!
  return {
    sourceCount,
    aggregateEntries,
    unionAccounts,
    aggregateBlobBytes,
    band,
    measuredCycles,
  }
}

const normalizedShares = (
  source: Pick<CompositionSource, 'entries' | 'totalValue'>,
  accounts: Address[]
) => {
  const values = new Map(
    source.entries.map(({ account, value }) => [account.toLowerCase(), value])
  )
  return accounts.map(
    (account) =>
      Number(values.get(account.toLowerCase()) ?? 0n) /
      Number(source.totalValue)
  )
}

const correlation = (left: number[], right: number[]) => {
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length
  let numerator = 0
  let leftSquare = 0
  let rightSquare = 0
  for (let index = 0; index < left.length; index++) {
    const a = left[index]! - leftMean
    const b = right[index]! - rightMean
    numerator += a * b
    leftSquare += a * a
    rightSquare += b * b
  }
  if (leftSquare === 0 || rightSquare === 0)
    return leftSquare === rightSquare ? 1 : 0
  return numerator / Math.sqrt(leftSquare * rightSquare)
}

const distributionDisagreement = (
  left: CompositionEntry[],
  right: CompositionEntry[]
) => {
  const leftTotal = left.reduce((sum, entry) => sum + entry.value, 0n)
  const rightTotal = right.reduce((sum, entry) => sum + entry.value, 0n)
  const accounts = new Set([
    ...left.map((entry) => entry.account.toLowerCase()),
    ...right.map((entry) => entry.account.toLowerCase()),
  ])
  let distance = 0
  const leftMap = new Map(
    left.map((entry) => [entry.account.toLowerCase(), entry.value])
  )
  const rightMap = new Map(
    right.map((entry) => [entry.account.toLowerCase(), entry.value])
  )
  for (const account of accounts) {
    distance += Math.abs(
      Number(leftMap.get(account) ?? 0n) / Number(leftTotal) -
        Number(rightMap.get(account) ?? 0n) / Number(rightTotal)
    )
  }
  return distance / 2
}

const topAccounts = (entries: CompositionEntry[], count = 5) =>
  [...entries]
    .sort((left, right) => {
      const value = cmpBig(right.value, left.value)
      return value !== 0 ? value : cmpHex(left.account, right.account)
    })
    .slice(0, count)
    .map((entry) => entry.account)

const metricsFor = (
  sources: CompositionSource[],
  output: CompositionEntry[],
  computeWithout: (sourceId: Hex) => CompositionEntry[]
): CompositionMetrics => {
  const support = new Map<string, number>()
  for (const source of sources) {
    for (const entry of source.entries) {
      support.set(
        entry.account.toLowerCase(),
        (support.get(entry.account.toLowerCase()) ?? 0) + 1
      )
    }
  }
  const pairwise: PairwiseMetric[] = []
  for (let leftIndex = 0; leftIndex < sources.length; leftIndex++) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < sources.length;
      rightIndex++
    ) {
      const left = sources[leftIndex]!
      const right = sources[rightIndex]!
      const leftAccounts = new Set(
        left.entries.map((entry) => entry.account.toLowerCase())
      )
      const rightAccounts = new Set(
        right.entries.map((entry) => entry.account.toLowerCase())
      )
      const accounts = [
        ...new Set([...leftAccounts, ...rightAccounts]),
      ].sort() as Address[]
      const overlapAccounts = [...leftAccounts].filter((account) =>
        rightAccounts.has(account)
      ).length
      const leftShares = normalizedShares(left, accounts)
      const rightShares = normalizedShares(right, accounts)
      pairwise.push({
        left: left.sourceId,
        right: right.sourceId,
        overlapAccounts,
        unionAccounts: accounts.length,
        overlapRatio:
          accounts.length === 0 ? 0 : overlapAccounts / accounts.length,
        correlation: correlation(leftShares, rightShares),
        disagreement:
          leftShares.reduce(
            (sum, value, index) => sum + Math.abs(value - rightShares[index]!),
            0
          ) / 2,
      })
    }
  }
  const baselineTop = topAccounts(output)
  const leaveOneOut = sources.map((source) => {
    const without = computeWithout(source.sourceId)
    const withoutTop = topAccounts(without)
    return {
      omittedSourceId: source.sourceId,
      disagreement: distributionDisagreement(output, without),
      changedTopAccounts: [...new Set([...baselineTop, ...withoutTop])].filter(
        (account) =>
          baselineTop.indexOf(account) !== withoutTop.indexOf(account)
      ),
      topAccounts: withoutTop,
    }
  })
  const shares = output.map(
    (entry) =>
      Number(entry.value) /
      Number(output.reduce((sum, item) => sum + item.value, 0n))
  )
  const sortedShares = [...shares].sort((left, right) => right - left)
  return {
    pairwise,
    leaveOneOut,
    accountsInEverySource: [...support.values()].filter(
      (count) => count === sources.length
    ).length,
    accountsInOneSource: [...support.values()].filter((count) => count === 1)
      .length,
    supportCoverage:
      support.size === 0
        ? 0
        : [...support.values()].reduce((sum, count) => sum + count, 0) /
          (support.size * sources.length),
    largestShare: sortedShares[0] ?? 0,
    top10Share: sortedShares
      .slice(0, 10)
      .reduce((sum, value) => sum + value, 0),
    hhi: shares.reduce((sum, value) => sum + value * value, 0),
  }
}

const validateConfig = (config: CompositionConfig) => {
  requireUint(config.chainId, 64, 'chainId')
  requireUint(config.captureBlock, 64, 'captureBlock')
  requireUint(config.outputPool, 128, 'outputPool')
  canonicalWord(config.scopeHash, 'scopeHash')
  if (config.paramsVersion === 1) {
    if (config.admittedProgramId === null) {
      fail('a V1 composition names one admitted score program')
    } else {
      canonicalWord(config.admittedProgramId, 'admittedProgramId')
    }
  } else if (config.admittedProgramId !== null) {
    fail('a V2 composition admits the compatibility class, not one program')
  }
  if (config.scopeHash === ZERO_HASH) fail('scopeHash must be nonzero')
  if (config.outputPool === 0n) fail('outputPool must be positive')
  if (
    config.sources.length < 2 ||
    config.sources.length > config.bounds.maxSources
  ) {
    fail('source count is outside the configured 2–8 bound')
  }
  for (const [key, maximum] of Object.entries(V1_COMPOSITION_BOUNDS)) {
    const value = config.bounds[key as keyof CompositionBounds]
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      fail(`${key} exceeds the V1 bound ${maximum}`)
    }
  }
}

const computeAllocations = (
  sources: CompositionSource[],
  outputPool: bigint
) => {
  const quotas = hamilton(
    outputPool,
    WEIGHT_SCALE,
    sources.map((source) => ({
      key: source.sourceId,
      numerator: source.weight,
      data: source,
    }))
  )
  if (quotas.some((row) => row.allocation === 0n)) {
    fail(
      'a required source receives a zero quota; raise the output pool or its weight'
    )
  }
  const attribution: SourceAttribution[] = []
  const sourceAllocations = quotas.map(
    ({ data: source, allocation: quota }) => {
      const apportioned = hamilton(
        quota,
        source.totalValue,
        source.entries.map((entry) => ({
          key: entry.account,
          numerator: entry.value,
          data: entry,
        }))
      )
      const entries = apportioned
        .filter((row) => row.allocation > 0n)
        .map((row) => ({ account: row.data.account, value: row.allocation }))
      for (const row of apportioned) {
        attribution.push({
          sourceId: source.sourceId,
          account: row.data.account,
          exactValue: row.allocation,
          idealNumerator: quota * row.data.value,
          idealDenominator: source.totalValue,
          roundingDeltaNumerator:
            row.allocation * source.totalValue - quota * row.data.value,
        })
      }
      return { sourceId: source.sourceId, quota, entries }
    }
  )
  const combined = new Map<Address, bigint>()
  for (const source of sourceAllocations) {
    for (const entry of source.entries) {
      combined.set(
        entry.account,
        (combined.get(entry.account) ?? 0n) + entry.value
      )
    }
  }
  const output = [...combined]
    .map(([account, value]) => ({ account, value }))
    .filter((entry) => entry.value > 0n)
    .sort((left, right) => cmpHex(left.account, right.account))
  return { sourceAllocations, attribution, output }
}

export const computeCompositionPreview = (
  rawConfig: CompositionConfig,
  options: { metrics?: boolean } = { metrics: true }
): CompositionPreview => {
  validateConfig(rawConfig)
  const sources = [...rawConfig.sources]
    .map((source) => ({
      ...source,
      sourceId: canonicalWord(source.sourceId, 'sourceId'),
      familyId: canonicalWord(source.familyId, 'familyId'),
      programId: canonicalWord(source.programId, 'programId'),
      outputRoot: canonicalWord(source.outputRoot, 'outputRoot'),
      blobSha256: canonicalWord(source.blobSha256, 'blobSha256'),
      deploymentProvenance: canonicalWord(
        source.deploymentProvenance,
        'deploymentProvenance'
      ),
      entries: orderedEntries(source.entries),
    }))
    .sort((left, right) => cmpHex(left.sourceId, right.sourceId))
  const sourceIds = new Set<string>()
  const snapshots = new Set<string>()
  let weightSum = 0n
  let aggregateEntries = 0
  let aggregateBlobBytes = 0
  const union = new Set<string>()
  for (const source of sources) {
    if (sourceIds.has(source.sourceId))
      fail(`duplicate sourceId ${source.sourceId}`)
    if (snapshots.has(source.snapshot.toLowerCase())) {
      fail(`duplicate source snapshot ${source.snapshot}`)
    }
    sourceIds.add(source.sourceId)
    snapshots.add(source.snapshot.toLowerCase())
    if (!source.available) {
      fail(
        `source ${source.name} is unavailable${source.availabilityError ? `: ${source.availabilityError}` : ''}`
      )
    }
    if (source.chainId !== rawConfig.chainId)
      fail(`source ${source.name} is on another chain`)
    if (rawConfig.paramsVersion === 1) {
      if (source.programId !== rawConfig.admittedProgramId) {
        fail(`source ${source.name} uses a different score program`)
      }
    } else if (admittedSourceOutputDomain(source.programId) === null) {
      fail(`source ${source.name} is not in the compatibility class`)
    }
    if (source.weight <= 0n) fail(`source ${source.name} has zero weight`)
    requireUint(source.weight, 64, 'source weight')
    weightSum += source.weight
    if (source.totalValue <= 0n)
      fail(`source ${source.name} has an empty total`)
    requireUint(source.totalValue, 128, 'source total')
    requireUint(source.stateIndex, 64, 'source state index')
    requireUint(source.freezeBlock, 64, 'source freeze block')
    requireUint(source.maxAgeBlocks, 64, 'source maximum age')
    if (
      source.maxAgeBlocks <= 0n ||
      source.maxAgeBlocks > MAX_SOURCE_AGE_BLOCKS
    ) {
      fail(`source ${source.name} has an invalid maximum age`)
    }
    if (
      source.freezeBlock > rawConfig.captureBlock ||
      rawConfig.captureBlock - source.freezeBlock > source.maxAgeBlocks
    ) {
      fail(`source ${source.name} is stale at the preview block`)
    }
    if (source.entries.length > rawConfig.bounds.maxEntriesPerSource) {
      fail(`source ${source.name} exceeds the per-source entry cap`)
    }
    const total = source.entries.reduce((sum, entry) => sum + entry.value, 0n)
    if (total !== source.totalValue)
      fail(`source ${source.name} total does not match its entries`)
    const blob = canonicalCompositionBlob(source.entries)
    const digest = digestToHex(sha256Utf8(blob))
    if (digest !== source.blobSha256)
      fail(`source ${source.name} blob digest mismatch`)
    if (cidV1Raw(sha256Utf8(blob)) !== source.cid)
      fail(`source ${source.name} CID mismatch`)
    if (compositionOutputRoot(source.entries) !== source.outputRoot) {
      fail(`source ${source.name} output root mismatch`)
    }
    aggregateEntries += source.entries.length
    aggregateBlobBytes += byteLength(blob)
    source.entries.forEach((entry) => union.add(entry.account))
  }
  if (weightSum !== WEIGHT_SCALE)
    fail('configured source weights must total exactly 100%')
  if (aggregateEntries > rawConfig.bounds.maxAggregateEntries) {
    fail('aggregate source entries exceed the configured cap')
  }
  if (union.size > rawConfig.bounds.maxUnionAccounts) {
    fail('union accounts exceed the configured cap')
  }
  if (aggregateBlobBytes > rawConfig.bounds.maxAggregateBlobBytes) {
    fail('aggregate canonical source bytes exceed the configured cap')
  }

  const config = { ...rawConfig, sources }
  const { sourceAllocations, attribution, output } = computeAllocations(
    sources,
    config.outputPool
  )
  const totalValue = output.reduce((sum, entry) => sum + entry.value, 0n)
  if (totalValue !== config.outputPool)
    fail('composition output does not conserve its pool')
  const outputBlob = canonicalCompositionBlob(output)
  const outputDigest = sha256Utf8(outputBlob)
  const policyManifest = canonicalPolicyManifest(
    config.chainId,
    sources,
    config.paramsVersion
  )
  const captureManifest = canonicalCaptureManifest(config, sources)
  const emptyMetrics: CompositionMetrics = {
    pairwise: [],
    leaveOneOut: [],
    accountsInEverySource: 0,
    accountsInOneSource: 0,
    supportCoverage: 0,
    largestShare: 0,
    top10Share: 0,
    hhi: 0,
  }
  const metrics =
    options.metrics === false
      ? emptyMetrics
      : metricsFor(sources, output, (omittedSourceId) => {
          const remaining = sources.filter(
            (source) => source.sourceId !== omittedSourceId
          )
          const remainingWeight = remaining.reduce(
            (sum, source) => sum + source.weight,
            0n
          )
          const normalized = new Map(
            hamilton(
              WEIGHT_SCALE,
              remainingWeight,
              remaining.map((source) => ({
                key: source.sourceId,
                numerator: source.weight,
                data: source,
              }))
            ).map((row) => [row.data.sourceId, row.allocation])
          )
          return computeAllocations(
            remaining.map((source) => ({
              ...source,
              weight: normalized.get(source.sourceId)!,
            })),
            config.outputPool
          ).output
        })
  return {
    policyManifest,
    policyManifestSha256: sha256(policyManifest),
    sourcePolicyRoot: compositionPolicyRoot(sources, config.paramsVersion),
    captureManifest,
    captureManifestSha256: sha256(captureManifest),
    sourceAllocations,
    attribution,
    output,
    outputBlob,
    outputBlobSha256: digestToHex(outputDigest),
    outputCid: cidV1Raw(outputDigest),
    outputRoot: compositionOutputRoot(output),
    totalValue,
    work: classifyCompositionWork(
      sources.length,
      aggregateEntries,
      union.size,
      aggregateBlobBytes
    ),
    metrics,
  }
}

export type SimplexSample = {
  weights: [number, number, number]
  outputRoot: Hex
  topAccounts: Address[]
  changedTopAccounts: Address[]
}

/** Exploratory A/B/C sensitivity points. Every sample keeps every source nonzero. */
export const compositionSimplex = (
  config: CompositionConfig,
  stepPercent = 10
): SimplexSample[] => {
  if (config.sources.length !== 3) return []
  if (!Number.isInteger(stepPercent) || stepPercent < 1 || stepPercent > 49) {
    fail('simplex step must be an integer from 1 to 49')
  }
  const baseline = computeCompositionPreview(config, { metrics: false })
  const baselineTop = topAccounts(baseline.output)
  const result: SimplexSample[] = []
  for (let a = stepPercent; a <= 100 - 2 * stepPercent; a += stepPercent) {
    for (let b = stepPercent; b <= 100 - a - stepPercent; b += stepPercent) {
      const c = 100 - a - b
      const percents = [a, b, c] as const
      const weighted = config.sources.map((source, index) => ({
        ...source,
        weight: BigInt(percents[index]) * 10n ** 16n,
      }))
      const preview = computeCompositionPreview(
        { ...config, sources: weighted },
        { metrics: false }
      )
      const top = topAccounts(preview.output)
      result.push({
        weights: [a, b, c],
        outputRoot: preview.outputRoot,
        topAccounts: top,
        changedTopAccounts: [...new Set([...baselineTop, ...top])].filter(
          (account) => baselineTop.indexOf(account) !== top.indexOf(account)
        ),
      })
    }
  }
  return result
}

export type LandedCompositionCommitments = {
  policyManifestSha256: Hex
  captureManifestSha256: Hex
  outputRoot: Hex
  outputBlobSha256: Hex
  outputCid: string
}

export const comparePreviewToLanded = (
  preview: CompositionPreview,
  landed: LandedCompositionCommitments
) => {
  const fields = {
    policyManifestSha256:
      preview.policyManifestSha256 === landed.policyManifestSha256,
    captureManifestSha256:
      preview.captureManifestSha256 === landed.captureManifestSha256,
    outputRoot: preview.outputRoot === landed.outputRoot,
    outputBlobSha256: preview.outputBlobSha256 === landed.outputBlobSha256,
    outputCid: preview.outputCid === landed.outputCid,
  }
  return { fields, byteIdentical: Object.values(fields).every(Boolean) }
}
