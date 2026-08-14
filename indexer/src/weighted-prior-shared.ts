import {
  type Address,
  type Hex,
  bytesToHex,
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  sha256,
} from 'viem'

export const WEIGHTED_SCALE = 1_000_000_000_000_000_000n
export const MAX_PRIOR_ENTRIES = 2_048

export type WeightedParams = {
  version: number
  dampingFp: bigint
  toleranceFp: bigint
  maxIterations: number
  minWeight: bigint
  maxWeight: bigint
  priorRoot: Hex
  priorCount: number
  manifestSha256: Hex
  schemaUid: Hex
  weightFieldIndex: number
  accumulator: Address
  chainId: bigint
}

export type WeightedParamsJson = {
  version: number
  dampingFp: string
  toleranceFp: string
  maxIterations: number
  minWeight: string
  maxWeight: string
  priorRoot: Hex
  priorCount: number
  manifestSha256: Hex
  schemaUid: Hex
  weightFieldIndex: number
  accumulator: Address
  chainId: string
}

export type WeightedPriorEntry = {
  account: Address
  normalizedWeight: bigint
}

const readBigEndian = (bytes: Uint8Array, start: number, length: number) => {
  let value = 0n
  for (let index = start; index < start + length; index++) {
    value = (value << 8n) | BigInt(bytes[index]!)
  }
  return value
}

const sameHex = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase()

export const normalizeWeightedParams = (params: WeightedParams) => {
  const paramsJson: WeightedParamsJson = {
    version: params.version,
    dampingFp: params.dampingFp.toString(),
    toleranceFp: params.toleranceFp.toString(),
    maxIterations: params.maxIterations,
    minWeight: params.minWeight.toString(),
    maxWeight: params.maxWeight.toString(),
    priorRoot: params.priorRoot,
    priorCount: params.priorCount,
    manifestSha256: params.manifestSha256,
    schemaUid: params.schemaUid,
    weightFieldIndex: params.weightFieldIndex,
    accumulator: params.accumulator,
    chainId: params.chainId.toString(),
  }
  const hash = keccak256(
    encodeAbiParameters(
      [
        { type: 'uint32' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'uint32' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'bytes32' },
        { type: 'uint32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint32' },
        { type: 'address' },
        { type: 'uint64' },
      ],
      [
        params.version,
        params.dampingFp,
        params.toleranceFp,
        params.maxIterations,
        params.minWeight,
        params.maxWeight,
        params.priorRoot,
        params.priorCount,
        params.manifestSha256,
        params.schemaUid,
        params.weightFieldIndex,
        params.accumulator,
        params.chainId,
      ]
    )
  )
  return { paramsJson, hash }
}

const priorRoot = (entries: WeightedPriorEntry[]): Hex => {
  let level = entries.map((entry) =>
    keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }],
        [entry.account, entry.normalizedWeight]
      )
    )
  )
  while (level.length > 1) {
    const next: Hex[] = []
    for (let index = 0; index < level.length; index += 2) {
      if (index + 1 === level.length) {
        next.push(level[index]!)
        continue
      }
      const pair = [level[index]!, level[index + 1]!].sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase())
      )
      next.push(keccak256(`0x${pair[0]!.slice(2)}${pair[1]!.slice(2)}`))
    }
    level = next
  }
  return level[0]!
}

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

export const rawCid = (digest: Hex) => {
  const digestBytes = hexToBytes(digest)
  const bytes = new Uint8Array(4 + digestBytes.length)
  bytes.set([0x01, 0x55, 0x12, 0x20])
  bytes.set(digestBytes, 4)
  return `b${base32(bytes)}`
}

/** Parse and verify every frozen TGWP commitment. Throws on any mismatch. */
export const verifyWeightedManifest = (
  manifest: Hex,
  params: WeightedParams,
  connectedChainId: bigint
) => {
  if (params.version !== 1)
    throw new Error(`unsupported params version ${params.version}`)
  if (params.chainId !== connectedChainId) {
    throw new Error(
      `params chain ${params.chainId} does not match indexed chain ${connectedChainId}`
    )
  }
  const bytes = hexToBytes(manifest)
  if (bytes.length < 18) throw new Error(`manifest too short: ${bytes.length}`)
  if (String.fromCharCode(...bytes.slice(0, 4)) !== 'TGWP') {
    throw new Error('invalid TGWP magic')
  }
  const manifestVersion = Number(readBigEndian(bytes, 4, 2))
  if (manifestVersion !== 1) {
    throw new Error(`unsupported manifest version ${manifestVersion}`)
  }
  const chainId = readBigEndian(bytes, 6, 8)
  if (chainId !== params.chainId) {
    throw new Error(
      `manifest chain ${chainId} does not match params chain ${params.chainId}`
    )
  }
  const count = Number(readBigEndian(bytes, 14, 4))
  if (count === 0 || count > MAX_PRIOR_ENTRIES) {
    throw new Error(`invalid prior count ${count}`)
  }
  const expectedLength = 18 + count * 28
  if (bytes.length !== expectedLength) {
    throw new Error(
      `manifest length ${bytes.length} does not equal ${expectedLength}`
    )
  }
  if (count !== params.priorCount) {
    throw new Error(
      `manifest count ${count} does not equal params count ${params.priorCount}`
    )
  }

  const entries: WeightedPriorEntry[] = []
  let total = 0n
  for (let position = 0; position < count; position++) {
    const start = 18 + position * 28
    const account = bytesToHex(bytes.slice(start, start + 20)) as Address
    const normalizedWeight = readBigEndian(bytes, start + 20, 8)
    if (/^0x0{40}$/i.test(account)) throw new Error('zero prior account')
    if (normalizedWeight === 0n)
      throw new Error(`zero prior weight at ${position}`)
    if (
      position > 0 &&
      entries[position - 1]!.account.toLowerCase() >= account.toLowerCase()
    ) {
      throw new Error(`prior accounts are not strictly sorted at ${position}`)
    }
    entries.push({ account, normalizedWeight })
    total += normalizedWeight
  }
  if (total !== WEIGHTED_SCALE) {
    throw new Error(
      `normalized prior sum ${total} does not equal ${WEIGHTED_SCALE}`
    )
  }
  const root = priorRoot(entries)
  if (!sameHex(root, params.priorRoot)) {
    throw new Error(`prior root ${root} does not equal ${params.priorRoot}`)
  }
  const digest = sha256(manifest)
  if (!sameHex(digest, params.manifestSha256)) {
    throw new Error(
      `manifest digest ${digest} does not equal ${params.manifestSha256}`
    )
  }
  return { entries, root, digest, cid: rawCid(digest) }
}

export const activatedStatuses = (
  versions: Array<{ version: bigint; status: string }>,
  activatedVersion: bigint
) =>
  versions.map((row) => ({
    ...row,
    status:
      row.version === activatedVersion
        ? 'active'
        : row.status === 'active'
          ? 'superseded'
          : row.status,
  }))

export type PriorLifecycleEvent =
  | { kind: 'published'; version: bigint }
  | { kind: 'proposed'; version: bigint }
  | { kind: 'activated'; version: bigint }
  | { kind: 'cancelled'; version: bigint }

/** Pure replay model for the deterministic IDs used by the Ponder handlers. */
export const replayPriorLifecycle = (events: PriorLifecycleEvent[]) => {
  const versions = new Map<bigint, string>()
  for (const event of events) {
    if (event.kind === 'published') versions.set(event.version, 'active')
    if (event.kind === 'proposed') versions.set(event.version, 'pending')
    if (event.kind === 'cancelled') versions.set(event.version, 'cancelled')
    if (event.kind === 'activated') {
      for (const [version, status] of versions) {
        if (status === 'active') versions.set(version, 'superseded')
      }
      versions.set(event.version, 'active')
    }
  }
  return versions
}
