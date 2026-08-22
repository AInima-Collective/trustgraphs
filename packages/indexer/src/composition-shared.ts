import {
  type Address,
  type Hex,
  bytesToHex,
  concat,
  encodeAbiParameters,
  hexToBytes,
  isAddress,
  keccak256,
  sha256,
  stringToHex,
} from 'viem'

export const COMPOSITION_PROGRAM = keccak256(stringToHex('trust-compose'))
export const COMPOSITION_IDENTITY_DOMAIN = keccak256(
  stringToHex('eip155-address')
)
export const COMPOSITION_OUTPUT_KIND = keccak256(stringToHex('allocation'))
export const COMPOSITION_OUTPUT_DOMAIN = keccak256(
  stringToHex('trustgraphs.output.trust-compose-account.v1')
)
export const COMPOSITION_WEIGHT_SCALE = 1_000_000_000_000_000_000n
export const COMPOSITION_MAX_SOURCE_AGE = 500_000n
export const COMPOSITION_BOUNDS = {
  sources: 8,
  entriesPerSource: 4_096,
  aggregateEntries: 8_192,
  unionAccounts: 8_192,
  aggregateBlobBytes: 1_048_576,
} as const

const ZERO_WORD = `0x${'00'.repeat(32)}` as Hex
const CAPTURE_HEADER_BYTES = 23
const CAPTURE_RECORD_BYTES = 261
const POLICY_HEADER_BYTES = 15
const POLICY_RECORD_BYTES = 133
const U128_MAX = (1n << 128n) - 1n

export type CompositionParams = {
  version: number
  programId: Hex
  scopeHash: Hex
  identityDomain: Hex
  outputKind: Hex
  outputDomain: Hex
  admittedProgramId: Hex
  weightScale: bigint
  outputPool: bigint
  sourcePolicyRoot: Hex
  sourceCount: number
  policyManifestSha256: Hex
  maxSources: number
  maxEntriesPerSource: number
  maxAggregateEntries: number
  maxUnionAccounts: number
  maxAggregateBlobBytes: number
  maxSourceAgeBlocks: bigint
  accumulator: Address
  chainId: bigint
}

export type CompositionParamsJson = Omit<
  CompositionParams,
  'weightScale' | 'outputPool' | 'maxSourceAgeBlocks' | 'chainId'
> & {
  weightScale: string
  outputPool: string
  maxSourceAgeBlocks: string
  chainId: string
}

export type CompositionPolicySource = {
  sourceId: Hex
  snapshot: Address
  familyId: Hex
  programId: Hex
  weight: bigint
  maxAgeBlocks: bigint
  required: boolean
}

export type CompositionCapturedSource = CompositionPolicySource & {
  stateIndex: bigint
  freezeBlock: bigint
  outputRoot: Hex
  blobSha256: Hex
  cidDigest: Hex
  totalValue: bigint
}

export type CompositionSourcePreimage = {
  cid: string
  blob: Uint8Array
}

export type CompositionAllocation = {
  sourceId: Hex
  quota: bigint
  allocations: Array<{
    account: Address
    value: bigint
    idealNumerator: bigint
    idealDenominator: bigint
    roundingDeltaNumerator: bigint
  }>
}

export type CompositionResult = {
  manifestSha256: Hex
  captureBlock: bigint
  sources: CompositionCapturedSource[]
  sourceAllocations: CompositionAllocation[]
  attribution: Array<{
    sourceId: Hex
    account: Address
    exactValue: bigint
    idealNumerator: bigint
    idealDenominator: bigint
    roundingDeltaNumerator: bigint
  }>
  output: Array<{ account: Address; value: bigint }>
  outputBlob: Uint8Array
  outputBlobSha256: Hex
  outputCid: string
  outputRoot: Hex
  totalValue: bigint
  work: {
    sourceCount: number
    aggregateEntries: number
    unionAccounts: number
    outputAccounts: number
    aggregateBlobBytes: number
  }
  metrics: {
    overlapAccounts: number
    coverageFp: bigint
    pairwiseDisagreementFp: bigint
  }
}

export type CompositionAcceptedState = {
  programId: Hex
  outputDomain: Hex
  paramsHash: Hex
  captureCommitment: Hex
  captureCount: bigint
  outputRoot: Hex
  outputBlobSha256: Hex
  outputCid: string
  totalValue: bigint
  acceptedRoot: Hex
  acceptedBlobSha256: Hex
  acceptedCid: string
  acceptedTotalValue: bigint
}

const sameHex = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase()

const fail = (message: string): never => {
  throw new Error(`trust-compose verification refused: ${message}`)
}

const requireWord = (value: string, label: string): Hex => {
  if (!/^0x[0-9a-f]{64}$/.test(value)) fail(`${label} is not lowercase bytes32`)
  return value as Hex
}

const readUint = (bytes: Uint8Array, start: number, length: number) => {
  let value = 0n
  for (let index = start; index < start + length; index++) {
    value = (value << 8n) | BigInt(bytes[index]!)
  }
  return value
}

const sliceHex = (bytes: Uint8Array, start: number, length: number) =>
  bytesToHex(bytes.slice(start, start + length)) as Hex

const magic = (bytes: Uint8Array, length = 4) =>
  String.fromCharCode(...bytes.slice(0, length))

const compareHex = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0

const base32 = (bytes: Uint8Array) => {
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
      accumulator &= (1 << bits) - 1
    }
  }
  if (bits > 0) output += alphabet[(accumulator << (5 - bits)) & 31]
  return output
}

export const rawCompositionCid = (digest: Hex) => {
  requireWord(digest, 'sha256 digest')
  return `b${base32(
    Uint8Array.from([0x01, 0x55, 0x12, 0x20, ...hexToBytes(digest)])
  )}`
}

export const normalizeCompositionParams = (params: CompositionParams) => {
  const paramsJson: CompositionParamsJson = {
    ...params,
    weightScale: params.weightScale.toString(),
    outputPool: params.outputPool.toString(),
    maxSourceAgeBlocks: params.maxSourceAgeBlocks.toString(),
    chainId: params.chainId.toString(),
  }
  const hash = keccak256(
    encodeAbiParameters(
      [
        { type: 'uint32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint64' },
        { type: 'uint128' },
        { type: 'bytes32' },
        { type: 'uint8' },
        { type: 'bytes32' },
        { type: 'uint8' },
        { type: 'uint32' },
        { type: 'uint32' },
        { type: 'uint32' },
        { type: 'uint32' },
        { type: 'uint64' },
        { type: 'address' },
        { type: 'uint64' },
      ],
      [
        params.version,
        params.programId,
        params.scopeHash,
        params.identityDomain,
        params.outputKind,
        params.outputDomain,
        params.admittedProgramId,
        params.weightScale,
        params.outputPool,
        params.sourcePolicyRoot,
        params.sourceCount,
        params.policyManifestSha256,
        params.maxSources,
        params.maxEntriesPerSource,
        params.maxAggregateEntries,
        params.maxUnionAccounts,
        params.maxAggregateBlobBytes,
        params.maxSourceAgeBlocks,
        params.accumulator,
        params.chainId,
      ]
    )
  )
  return { paramsJson, hash }
}

export const compositionParamsFromJson = (
  params: CompositionParamsJson
): CompositionParams => ({
  ...params,
  weightScale: BigInt(params.weightScale),
  outputPool: BigInt(params.outputPool),
  maxSourceAgeBlocks: BigInt(params.maxSourceAgeBlocks),
  chainId: BigInt(params.chainId),
})

const validateParams = (
  params: CompositionParams,
  connectedChainId: bigint
) => {
  if (params.version !== 1) fail(`unsupported params version ${params.version}`)
  if (!sameHex(params.programId, COMPOSITION_PROGRAM)) fail('wrong program id')
  if (!sameHex(params.identityDomain, COMPOSITION_IDENTITY_DOMAIN))
    fail('wrong identity domain')
  if (!sameHex(params.outputKind, COMPOSITION_OUTPUT_KIND))
    fail('wrong output kind')
  if (!sameHex(params.outputDomain, COMPOSITION_OUTPUT_DOMAIN))
    fail('wrong output domain')
  if (
    params.scopeHash === ZERO_WORD ||
    params.admittedProgramId === ZERO_WORD ||
    sameHex(params.admittedProgramId, COMPOSITION_PROGRAM)
  )
    fail('invalid scope or admitted program')
  if (params.weightScale !== COMPOSITION_WEIGHT_SCALE)
    fail('unsupported weight scale')
  if (params.outputPool <= 0n || params.outputPool > U128_MAX)
    fail('invalid output pool')
  if (
    params.sourceCount < 2 ||
    params.sourceCount > params.maxSources ||
    params.maxSources > COMPOSITION_BOUNDS.sources ||
    params.maxEntriesPerSource <= 0 ||
    params.maxEntriesPerSource > COMPOSITION_BOUNDS.entriesPerSource ||
    params.maxAggregateEntries <= 0 ||
    params.maxAggregateEntries > COMPOSITION_BOUNDS.aggregateEntries ||
    params.maxUnionAccounts <= 0 ||
    params.maxUnionAccounts > COMPOSITION_BOUNDS.unionAccounts ||
    params.maxAggregateBlobBytes <= 0 ||
    params.maxAggregateBlobBytes > COMPOSITION_BOUNDS.aggregateBlobBytes ||
    params.maxEntriesPerSource > params.maxAggregateEntries ||
    params.maxUnionAccounts > params.maxAggregateEntries
  )
    fail('invalid composition bounds')
  if (
    params.maxSourceAgeBlocks <= 0n ||
    params.maxSourceAgeBlocks > COMPOSITION_MAX_SOURCE_AGE
  )
    fail('invalid maximum source age')
  if (params.chainId !== connectedChainId) fail('params chain mismatch')
  if (/^0x0{40}$/.test(params.accumulator)) fail('zero accumulator')
}

export const parseCompositionPolicy = (
  manifest: Hex,
  expectedChainId: bigint
): CompositionPolicySource[] => {
  const bytes = hexToBytes(manifest)
  if (bytes.length < POLICY_HEADER_BYTES) fail('policy manifest is too short')
  if (magic(bytes) !== 'TGCP') fail('invalid policy manifest magic')
  if (readUint(bytes, 4, 2) !== 1n) fail('unsupported policy manifest version')
  if (readUint(bytes, 6, 8) !== expectedChainId)
    fail('policy manifest chain mismatch')
  const count = Number(bytes[14])
  if (count < 2 || count > COMPOSITION_BOUNDS.sources)
    fail('invalid policy source count')
  const expectedLength = POLICY_HEADER_BYTES + count * POLICY_RECORD_BYTES
  if (bytes.length !== expectedLength) fail('policy manifest length mismatch')
  const sources: CompositionPolicySource[] = []
  for (let position = 0; position < count; position++) {
    const start = POLICY_HEADER_BYTES + position * POLICY_RECORD_BYTES
    sources.push({
      sourceId: sliceHex(bytes, start, 32),
      snapshot: sliceHex(bytes, start + 32, 20) as Address,
      familyId: sliceHex(bytes, start + 52, 32),
      programId: sliceHex(bytes, start + 84, 32),
      weight: readUint(bytes, start + 116, 8),
      maxAgeBlocks: readUint(bytes, start + 124, 8),
      required: bytes[start + 132] === 1,
    })
  }
  return sources
}

const policyLeaf = (source: CompositionPolicySource): Hex =>
  keccak256(
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
        source.required ? 1 : 0,
      ]
    )
  )

const hashPair = (left: Hex, right: Hex): Hex =>
  keccak256(
    concat(compareHex(left, right) <= 0 ? [left, right] : [right, left])
  )

export const compositionPolicyRoot = (
  sources: CompositionPolicySource[]
): Hex => {
  let level = sources.map(policyLeaf)
  while (level.length > 1) {
    const next: Hex[] = []
    for (let index = 0; index < level.length; index += 2) {
      const right = level[index + 1]
      next.push(right ? hashPair(level[index]!, right) : level[index]!)
    }
    level = next
  }
  return level[0] ?? ZERO_WORD
}

export const verifyCompositionPolicy = (
  manifest: Hex,
  params: CompositionParams,
  connectedChainId: bigint
) => {
  validateParams(params, connectedChainId)
  const sources = parseCompositionPolicy(manifest, params.chainId)
  if (sources.length !== params.sourceCount)
    fail('policy source count mismatch')
  let previous: string | undefined
  let weight = 0n
  const snapshots = new Set<string>()
  for (const source of sources) {
    if (
      source.sourceId === ZERO_WORD ||
      (previous && previous >= source.sourceId)
    )
      fail('policy source ids are not strictly sorted')
    previous = source.sourceId
    if (/^0x0{40}$/.test(source.snapshot) || snapshots.has(source.snapshot))
      fail('zero or duplicate policy snapshot')
    snapshots.add(source.snapshot)
    if (source.familyId === ZERO_WORD) fail('zero source family')
    if (!sameHex(source.programId, params.admittedProgramId))
      fail('unadmitted source program')
    if (!source.required) fail('optional source is unsupported')
    if (
      source.weight <= 0n ||
      source.maxAgeBlocks <= 0n ||
      source.maxAgeBlocks > params.maxSourceAgeBlocks
    )
      fail('invalid source policy weight or age')
    weight += source.weight
  }
  if (weight !== params.weightScale) fail('source weights do not sum to scale')
  const digest = sha256(manifest)
  if (!sameHex(digest, params.policyManifestSha256))
    fail('policy manifest digest mismatch')
  const root = compositionPolicyRoot(sources)
  if (!sameHex(root, params.sourcePolicyRoot))
    fail('source policy root mismatch')
  return { sources, digest, root }
}

export const parseCompositionCapture = (
  manifest: Hex,
  expectedChainId: bigint
) => {
  const bytes = hexToBytes(manifest)
  if (bytes.length < CAPTURE_HEADER_BYTES) fail('capture manifest is too short')
  if (magic(bytes) !== 'TGCM') fail('invalid capture manifest magic')
  if (readUint(bytes, 4, 2) !== 1n) fail('unsupported capture version')
  const chainId = readUint(bytes, 6, 8)
  if (chainId !== expectedChainId) fail('capture chain mismatch')
  const captureBlock = readUint(bytes, 14, 8)
  const count = Number(bytes[22])
  const expectedLength = CAPTURE_HEADER_BYTES + count * CAPTURE_RECORD_BYTES
  if (bytes.length !== expectedLength) fail('capture manifest length mismatch')
  const sources: CompositionCapturedSource[] = []
  for (let position = 0; position < count; position++) {
    const start = CAPTURE_HEADER_BYTES + position * CAPTURE_RECORD_BYTES
    sources.push({
      sourceId: sliceHex(bytes, start, 32),
      snapshot: sliceHex(bytes, start + 32, 20) as Address,
      familyId: sliceHex(bytes, start + 52, 32),
      programId: sliceHex(bytes, start + 84, 32),
      stateIndex: readUint(bytes, start + 116, 8),
      freezeBlock: readUint(bytes, start + 124, 8),
      outputRoot: sliceHex(bytes, start + 132, 32),
      blobSha256: sliceHex(bytes, start + 164, 32),
      cidDigest: sliceHex(bytes, start + 196, 32),
      totalValue: readUint(bytes, start + 228, 16),
      weight: readUint(bytes, start + 244, 8),
      maxAgeBlocks: readUint(bytes, start + 252, 8),
      required: bytes[start + 260] === 1,
    })
  }
  return { captureBlock, sources }
}

const canonicalBlob = (entries: Array<{ account: Address; value: bigint }>) =>
  new TextEncoder().encode(
    `{${entries
      .map(({ account, value }) => `"${account}":"${value.toString()}"`)
      .join(',')}}`
  )

export const decodeCompositionScoreBlob = (blob: Uint8Array) => {
  let text: string
  let parsed: unknown
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(blob)
    parsed = JSON.parse(text)
  } catch {
    return fail('source blob is not valid UTF-8 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    fail('source blob is not an object')
  const entries = Object.entries(parsed as Record<string, unknown>)
    .map(([account, value]) => {
      if (
        !/^0x[0-9a-f]{40}$/.test(account) ||
        !isAddress(account, { strict: false })
      )
        fail('source account is not a lowercase address')
      const textValue =
        typeof value === 'string'
          ? value
          : fail('source value is not a canonical positive decimal')
      if (!/^[1-9][0-9]*$/.test(textValue))
        fail('source value is not a canonical positive decimal')
      const parsedValue = BigInt(textValue)
      if (parsedValue > U128_MAX) fail('source value exceeds uint128')
      return { account: account as Address, value: parsedValue }
    })
    .sort((left, right) => compareHex(left.account, right.account))
  if (entries.length === 0) fail('source blob is empty')
  if (bytesToHex(canonicalBlob(entries)) !== bytesToHex(blob))
    fail('source blob bytes are not canonical')
  return entries
}

const outputLeaf = (account: Address, value: bigint): Hex => {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [account, value]
    )
  )
  return keccak256(inner)
}

export const compositionOutputRoot = (
  entries: Array<{ account: Address; value: bigint }>
): Hex => {
  const leaves = entries.map(({ account, value }) => outputLeaf(account, value))
  leaves.sort(compareHex)
  if (leaves.length === 0) return ZERO_WORD
  if (leaves.length === 1) return leaves[0]!
  const tree = new Array<Hex>(2 * leaves.length - 1)
  for (const [index, leaf] of leaves.entries())
    tree[tree.length - 1 - index] = leaf
  for (let index = leaves.length - 2; index >= 0; index--)
    tree[index] = hashPair(tree[index * 2 + 1]!, tree[index * 2 + 2]!)
  return tree[0]!
}

const hamilton = <T>(
  pool: bigint,
  denominator: bigint,
  items: Array<{ key: Hex; value: bigint; data: T }>
) => {
  if (pool < 0n || denominator <= 0n || items.length === 0)
    fail('invalid Hamilton inputs')
  if (
    items.some((item) => item.value <= 0n) ||
    items.reduce((sum, item) => sum + item.value, 0n) !== denominator
  )
    fail('Hamilton denominator mismatch')
  const rows = items.map((item) => ({
    ...item,
    allocation: (pool * item.value) / denominator,
    remainder: (pool * item.value) % denominator,
  }))
  let residual = pool - rows.reduce((sum, item) => sum + item.allocation, 0n)
  const order = [...rows].sort((left, right) =>
    left.remainder === right.remainder
      ? compareHex(left.key, right.key)
      : left.remainder > right.remainder
        ? -1
        : 1
  )
  for (const row of order) {
    if (residual === 0n) break
    row.allocation++
    residual--
  }
  if (residual !== 0n) fail('Hamilton residual exceeds item count')
  return rows.sort((left, right) => compareHex(left.key, right.key))
}

const sourceDisagreement = (
  entries: Array<Array<{ account: Address; value: bigint }>>,
  totals: bigint[]
) => {
  const scale = COMPOSITION_WEIGHT_SCALE
  let pairs = 0n
  let sum = 0n
  for (let left = 0; left < entries.length; left++) {
    const leftMap = new Map(
      entries[left]!.map((entry) => [entry.account, entry.value])
    )
    for (let right = left + 1; right < entries.length; right++) {
      const rightMap = new Map(
        entries[right]!.map((entry) => [entry.account, entry.value])
      )
      const accounts = new Set([...leftMap.keys(), ...rightMap.keys()])
      for (const account of accounts) {
        const a = ((leftMap.get(account) ?? 0n) * scale) / totals[left]!
        const b = ((rightMap.get(account) ?? 0n) * scale) / totals[right]!
        sum += a >= b ? a - b : b - a
      }
      pairs++
    }
  }
  return pairs === 0n ? 0n : sum / (2n * pairs)
}

/** Production, guest-identical recomputation. No research module is imported by this path. */
export const computeComposition = (
  params: CompositionParams,
  manifest: Hex,
  preimages: CompositionSourcePreimage[],
  connectedChainId: bigint
): CompositionResult => {
  validateParams(params, connectedChainId)
  const policy = verifyCompositionPolicy(
    policyManifestFromCapture(manifest),
    params,
    connectedChainId
  )
  const parsed = parseCompositionCapture(manifest, params.chainId)
  const sources = parsed.sources
  if (sources.length !== params.sourceCount)
    fail('capture source count mismatch')
  if (preimages.length !== sources.length)
    fail('source preimage count mismatch')
  const captureDigest = sha256(manifest)
  const snapshots = new Set<string>()
  let aggregateEntries = 0
  let aggregateBlobBytes = 0
  let weight = 0n
  let previous: string | undefined
  const validated = sources.map((source, position) => {
    const policySource = policy.sources[position]!
    if (
      source.sourceId !== policySource.sourceId ||
      source.snapshot !== policySource.snapshot ||
      source.familyId !== policySource.familyId ||
      source.programId !== policySource.programId ||
      source.weight !== policySource.weight ||
      source.maxAgeBlocks !== policySource.maxAgeBlocks ||
      source.required !== policySource.required
    )
      fail(`capture source ${position} conflicts with admitted policy`)
    if (previous && previous >= source.sourceId)
      fail('capture source ids are not strictly sorted')
    previous = source.sourceId
    if (snapshots.has(source.snapshot)) fail('duplicate source snapshot')
    snapshots.add(source.snapshot)
    if (
      !source.required ||
      !sameHex(source.programId, params.admittedProgramId) ||
      source.totalValue <= 0n
    )
      fail('invalid captured source')
    if (
      source.freezeBlock > parsed.captureBlock ||
      parsed.captureBlock - source.freezeBlock > source.maxAgeBlocks
    )
      fail(`source ${source.sourceId} is stale at capture`)
    weight += source.weight
    const preimage = preimages[position]!
    aggregateBlobBytes += preimage.blob.length
    if (!sameHex(sha256(preimage.blob), source.blobSha256))
      fail(`source ${source.sourceId} blob sha256 mismatch`)
    if (rawCompositionCid(source.blobSha256) !== preimage.cid)
      fail(`source ${source.sourceId} CID mismatch`)
    if (!sameHex(keccak256(stringToHex(preimage.cid)), source.cidDigest))
      fail(`source ${source.sourceId} CID digest mismatch`)
    const entries = decodeCompositionScoreBlob(preimage.blob)
    if (entries.length > params.maxEntriesPerSource)
      fail(`source ${source.sourceId} exceeds entry cap`)
    aggregateEntries += entries.length
    if (
      entries.reduce((sum, entry) => sum + entry.value, 0n) !==
      source.totalValue
    )
      fail(`source ${source.sourceId} total mismatch`)
    if (!sameHex(compositionOutputRoot(entries), source.outputRoot))
      fail(`source ${source.sourceId} root mismatch`)
    return { source, entries }
  })
  if (weight !== params.weightScale) fail('captured weight sum mismatch')
  if (aggregateBlobBytes > params.maxAggregateBlobBytes)
    fail('aggregate source bytes exceed cap')
  if (aggregateEntries > params.maxAggregateEntries)
    fail('aggregate source entries exceed cap')
  const union = new Set(
    validated.flatMap(({ entries }) => entries.map((entry) => entry.account))
  )
  if (union.size > params.maxUnionAccounts) fail('union accounts exceed cap')

  const quotas = hamilton(
    params.outputPool,
    params.weightScale,
    validated.map(({ source }, index) => ({
      key: source.sourceId,
      value: source.weight,
      data: index,
    }))
  )
  const combined = new Map<Address, bigint>()
  const attribution: CompositionResult['attribution'] = []
  const sourceAllocations = quotas.map((quota) => {
    if (quota.allocation === 0n)
      fail(`required source ${quota.key} received no output`)
    const { source, entries } = validated[quota.data]!
    const apportioned = hamilton(
      quota.allocation,
      source.totalValue,
      entries.map((entry) => ({
        key: entry.account as Hex,
        value: entry.value,
        data: entry,
      }))
    )
    for (const entry of apportioned) {
      const idealNumerator = params.outputPool * source.weight * entry.value
      const idealDenominator = params.weightScale * source.totalValue
      attribution.push({
        sourceId: source.sourceId,
        account: entry.data.account,
        exactValue: entry.allocation,
        idealNumerator,
        idealDenominator,
        roundingDeltaNumerator:
          entry.allocation * idealDenominator - idealNumerator,
      })
      // The guest drops zero Hamilton allocations before combining sources. Attribution retains
      // those exact zero rows for auditability, but they must never enter the canonical output.
      if (entry.allocation > 0n) {
        combined.set(
          entry.data.account,
          (combined.get(entry.data.account) ?? 0n) + entry.allocation
        )
      }
    }
    const allocations = apportioned
      .filter((entry) => entry.allocation > 0n)
      .map((entry) => {
        const idealNumerator = params.outputPool * source.weight * entry.value
        const idealDenominator = params.weightScale * source.totalValue
        return {
          account: entry.data.account,
          value: entry.allocation,
          idealNumerator,
          idealDenominator,
          roundingDeltaNumerator:
            entry.allocation * idealDenominator - idealNumerator,
        }
      })
    return { sourceId: source.sourceId, quota: quota.allocation, allocations }
  })
  const output = [...combined]
    .map(([account, value]) => ({ account, value }))
    .sort((left, right) => compareHex(left.account, right.account))
  const totalValue = output.reduce((sum, entry) => sum + entry.value, 0n)
  if (totalValue !== params.outputPool) fail('composite pool is not conserved')
  const outputBlob = canonicalBlob(output)
  const outputBlobSha256 = sha256(outputBlob)
  const appearances = new Map<Address, number>()
  for (const { entries } of validated) {
    for (const entry of entries)
      appearances.set(entry.account, (appearances.get(entry.account) ?? 0) + 1)
  }
  return {
    manifestSha256: captureDigest,
    captureBlock: parsed.captureBlock,
    sources,
    sourceAllocations,
    attribution,
    output,
    outputBlob,
    outputBlobSha256,
    outputCid: rawCompositionCid(outputBlobSha256),
    outputRoot: compositionOutputRoot(output),
    totalValue,
    work: {
      sourceCount: sources.length,
      aggregateEntries,
      unionAccounts: union.size,
      outputAccounts: output.length,
      aggregateBlobBytes,
    },
    metrics: {
      overlapAccounts: [...appearances.values()].filter((count) => count > 1)
        .length,
      coverageFp:
        union.size === 0
          ? 0n
          : (BigInt(aggregateEntries) * COMPOSITION_WEIGHT_SCALE) /
            BigInt(union.size * sources.length),
      pairwiseDisagreementFp: sourceDisagreement(
        validated.map(({ entries }) => entries),
        validated.map(({ source }) => source.totalValue)
      ),
    },
  }
}

/** Rebuild canonical TGCP policy bytes from the policy fields frozen into TGCM. */
export const policyManifestFromCapture = (capture: Hex): Hex => {
  const bytes = hexToBytes(capture)
  if (bytes.length < CAPTURE_HEADER_BYTES) fail('capture manifest is too short')
  const count = Number(bytes[22])
  if (bytes.length !== CAPTURE_HEADER_BYTES + count * CAPTURE_RECORD_BYTES)
    fail('capture manifest length mismatch')
  const output = new Uint8Array(
    POLICY_HEADER_BYTES + count * POLICY_RECORD_BYTES
  )
  output.set(new TextEncoder().encode('TGCP'), 0)
  output.set(bytes.slice(4, 14), 4)
  output[14] = count
  for (let position = 0; position < count; position++) {
    const captureStart = CAPTURE_HEADER_BYTES + position * CAPTURE_RECORD_BYTES
    const policyStart = POLICY_HEADER_BYTES + position * POLICY_RECORD_BYTES
    output.set(bytes.slice(captureStart, captureStart + 116), policyStart)
    output.set(
      bytes.slice(captureStart + 244, captureStart + 261),
      policyStart + 116
    )
  }
  return bytesToHex(output)
}

const attributionDigest = (result: CompositionResult) =>
  JSON.stringify(
    result.attribution.map((entry) => ({
      sourceId: entry.sourceId,
      account: entry.account,
      exactValue: entry.exactValue.toString(),
      idealNumerator: entry.idealNumerator.toString(),
      idealDenominator: entry.idealDenominator.toString(),
      roundingDeltaNumerator: entry.roundingDeltaNumerator.toString(),
    }))
  )

/** Refusal boundary used by live ingestion and its complete negative test matrix. */
export const verifyCompositionAcceptance = (
  params: CompositionParams,
  manifest: Hex,
  preimages: CompositionSourcePreimage[],
  accepted: CompositionAcceptedState,
  connectedChainId: bigint,
  claimedAttribution?: string
) => {
  if (!sameHex(accepted.programId, COMPOSITION_PROGRAM)) fail('wrong program')
  if (!sameHex(accepted.outputDomain, COMPOSITION_OUTPUT_DOMAIN))
    fail('wrong output domain')
  const normalized = normalizeCompositionParams(params)
  if (!sameHex(normalized.hash, accepted.paramsHash))
    fail('params hash mismatch')
  const result = computeComposition(
    params,
    manifest,
    preimages,
    connectedChainId
  )
  if (!sameHex(result.manifestSha256, accepted.captureCommitment))
    fail('capture manifest commitment mismatch')
  if (BigInt(result.sources.length) !== accepted.captureCount)
    fail('capture source count mismatch')
  if (!sameHex(result.outputRoot, accepted.outputRoot))
    fail('output root mismatch')
  if (!sameHex(result.outputBlobSha256, accepted.outputBlobSha256))
    fail('output blob digest mismatch')
  if (result.outputCid !== accepted.outputCid) fail('output CID mismatch')
  if (result.totalValue !== accepted.totalValue) fail('output total mismatch')
  if (
    !sameHex(result.outputRoot, accepted.acceptedRoot) ||
    !sameHex(result.outputBlobSha256, accepted.acceptedBlobSha256) ||
    result.outputCid !== accepted.acceptedCid ||
    result.totalValue !== accepted.acceptedTotalValue
  )
    fail('accepted on-chain state mismatch')
  if (
    claimedAttribution !== undefined &&
    claimedAttribution !== attributionDigest(result)
  )
    fail('attribution mismatch')
  return result
}

export const serializeCompositionAttribution = (result: CompositionResult) =>
  attributionDigest(result)
