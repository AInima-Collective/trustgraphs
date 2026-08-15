import { Buffer } from 'node:buffer'

import {
  concat,
  encodeAbiParameters,
  keccak256,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from 'viem'

import { fixturePolicy, postTriggerPolicy } from './fixture-builder'
import {
  COMPOSITION_VERSION,
  canonicalManifest,
  cidStringDigest,
  compose,
  decodeCanonicalScoreBlob,
  outputLeaf,
  sha256Hex,
  type CapturedSource,
  type CompositionPolicy,
} from './reference'

export const PROGRAM_ID = keccak256(stringToHex('trust-compose'))
export const IDENTITY_DOMAIN = keccak256(stringToHex('eip155-address'))
export const OUTPUT_KIND = keccak256(stringToHex('allocation'))
export const OUTPUT_DOMAIN = keccak256(
  stringToHex('trustgraphs.output.trust-compose-account.v1')
)
export const POLICY_MAGIC = 'TGCP'
export const MAX_SOURCE_AGE_BLOCKS = 500_000n

const ACCUMULATOR = `0x${'ac'.repeat(20)}` as Address
const RECIPIENT = `0x${'be'.repeat(20)}` as Address
const SNAPSHOT = `0x${'5a'.repeat(20)}` as Address
const ZERO_WORD = `0x${'00'.repeat(32)}` as Hex

type PolicySource = Pick<
  CapturedSource,
  | 'sourceId'
  | 'snapshot'
  | 'familyId'
  | 'programId'
  | 'weight'
  | 'maxAgeBlocks'
  | 'required'
>

const bytes = (value: Hex) => Buffer.from(value.slice(2), 'hex')

const u64be = (value: bigint) => {
  if (value < 0n || value > (1n << 64n) - 1n) throw new Error('uint64')
  const out = Buffer.alloc(8)
  out.writeBigUInt64BE(value)
  return out
}

const hashPair = (left: Hex, right: Hex): Hex =>
  keccak256(concat(left <= right ? [left, right] : [right, left]))

export const sourcePolicyLeaf = (source: PolicySource): Hex =>
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

/** Source-id-order leaves, sorted-pair parents, and odd-node promotion. */
export const sourcePolicyRoot = (sources: PolicySource[]): Hex => {
  let level = [...sources]
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
    .map(sourcePolicyLeaf)
  while (level.length > 1) {
    const next: Hex[] = []
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!
      const right = level[index + 1]
      next.push(right ? hashPair(left, right) : left)
    }
    level = next
  }
  return level[0] ?? ZERO_WORD
}

/** Compact static source-policy manifest consumed by the V1 Solidity/Rust validators. */
export const canonicalPolicyManifest = (
  chainId: bigint,
  sources: PolicySource[]
) => {
  const ordered = [...sources].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId)
  )
  return Buffer.concat([
    Buffer.from(POLICY_MAGIC),
    Buffer.from([0, COMPOSITION_VERSION]),
    u64be(chainId),
    Buffer.from([ordered.length]),
    ...ordered.map((source) =>
      Buffer.concat([
        bytes(source.sourceId),
        bytes(source.snapshot),
        bytes(source.familyId),
        bytes(source.programId),
        u64be(source.weight),
        u64be(source.maxAgeBlocks),
        Buffer.from([source.required ? 1 : 0]),
      ])
    ),
  ])
}

export type ProductionParams = {
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

export const paramsEncoded = (params: ProductionParams): Hex =>
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

export type ProductionJournal = {
  acc: Hex
  leafCount: bigint
  anchorAcc: Hex
  anchorCount: bigint
  paramsHash: Hex
  outputRoot: Hex
  ipfsHash: Hex
  cidDigest: Hex
  totalValue: bigint
  skippedDigest: Hex
  recipient: Address
  instanceDomain: Hex
}

export const journalEncoded = (journal: ProductionJournal): Hex =>
  encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'uint64' },
      { type: 'bytes32' },
      { type: 'uint64' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'uint256' },
      { type: 'bytes32' },
      { type: 'address' },
      { type: 'bytes32' },
    ],
    [
      journal.acc,
      journal.leafCount,
      journal.anchorAcc,
      journal.anchorCount,
      journal.paramsHash,
      journal.outputRoot,
      journal.ipfsHash,
      journal.cidDigest,
      journal.totalValue,
      journal.skippedDigest,
      journal.recipient,
      journal.instanceDomain,
    ]
  )

const outputProof = (
  output: Array<{ account: Hex; value: bigint }>,
  sampleIndex: number
) => {
  const sample = output[sampleIndex]!
  const sampleLeaf = outputLeaf(sample.account, sample.value)
  const leaves = output
    .map(({ account, value }) => outputLeaf(account, value))
    .sort()
  if (leaves.length === 1) return { sample, sampleLeaf, proof: [] as Hex[] }
  const tree = new Array<Hex>(2 * leaves.length - 1)
  for (const [index, leaf] of leaves.entries())
    tree[tree.length - 1 - index] = leaf
  for (let index = leaves.length - 2; index >= 0; index--)
    tree[index] = hashPair(tree[2 * index + 1]!, tree[2 * index + 2]!)
  let index = tree.findIndex(
    (value, position) => position >= leaves.length - 1 && value === sampleLeaf
  )
  const proof: Hex[] = []
  while (index > 0) {
    proof.push(tree[index % 2 === 1 ? index + 1 : index - 1]!)
    index = Math.floor((index - 1) / 2)
  }
  return { sample, sampleLeaf, proof }
}

const validatedSources = (policy: CompositionPolicy) =>
  [...policy.sources]
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
    .map((source) => ({
      ...source,
      entries: decodeCanonicalScoreBlob(source.blob),
    }))

const vectorFor = (policy: CompositionPolicy) => {
  const sources = validatedSources(policy)
  const result = compose(policy)
  const manifest = canonicalManifest(policy, sources)
  return { sources, result, manifest, manifestSha256: sha256Hex(manifest) }
}

const bigintStrings = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item
    )
  ) as T

export const productionGolden = () => {
  const policy = fixturePolicy()
  const current = vectorFor(policy)
  const next = vectorFor(postTriggerPolicy())
  const policyManifest = canonicalPolicyManifest(
    policy.chainId,
    current.sources
  )
  const params: ProductionParams = {
    version: 1,
    programId: PROGRAM_ID,
    scopeHash: policy.scopeHash,
    identityDomain: IDENTITY_DOMAIN,
    outputKind: OUTPUT_KIND,
    outputDomain: OUTPUT_DOMAIN,
    admittedProgramId: policy.admittedProgramId,
    weightScale: policy.weightScale,
    outputPool: policy.outputPool,
    sourcePolicyRoot: sourcePolicyRoot(current.sources),
    sourceCount: current.sources.length,
    policyManifestSha256: sha256Hex(policyManifest),
    maxSources: policy.bounds.maxSources,
    maxEntriesPerSource: policy.bounds.maxEntriesPerSource,
    maxAggregateEntries: policy.bounds.maxAggregateEntries,
    maxUnionAccounts: policy.bounds.maxUnionAccounts,
    maxAggregateBlobBytes: policy.bounds.maxAggregateBlobBytes,
    maxSourceAgeBlocks: MAX_SOURCE_AGE_BLOCKS,
    accumulator: ACCUMULATOR,
    chainId: policy.chainId,
  }
  const encodedParams = paramsEncoded(params)
  const paramsHash = keccak256(encodedParams)
  const instanceDomain = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [SNAPSHOT, policy.chainId]
    )
  )
  const journal: ProductionJournal = {
    acc: current.manifestSha256,
    leafCount: BigInt(current.sources.length),
    anchorAcc: ZERO_WORD,
    anchorCount: 0n,
    paramsHash,
    outputRoot: current.result.outputRoot,
    ipfsHash: current.result.outputBlobSha256,
    cidDigest: cidStringDigest(current.result.outputCid),
    totalValue: current.result.totalValue,
    skippedDigest: ZERO_WORD,
    recipient: RECIPIENT,
    instanceDomain,
  }
  const encodedJournal = journalEncoded(journal)
  const proof = outputProof(current.result.output, 3)

  return bigintStrings({
    schema: 'trust-compose-v1',
    constants: {
      programId: PROGRAM_ID,
      identityDomain: IDENTITY_DOMAIN,
      outputKind: OUTPUT_KIND,
      outputDomain: OUTPUT_DOMAIN,
      weightScale: policy.weightScale,
    },
    policyManifest: {
      encoded: toHex(policyManifest),
      sha256: sha256Hex(policyManifest),
      root: params.sourcePolicyRoot,
      leaves: current.sources.map(sourcePolicyLeaf),
      entries: current.sources.map((source) => ({
        sourceId: source.sourceId,
        snapshot: source.snapshot,
        familyId: source.familyId,
        programId: source.programId,
        weight: source.weight,
        maxAgeBlocks: source.maxAgeBlocks,
        required: source.required,
      })),
      count: current.sources.length,
    },
    capture: {
      manifest: toHex(current.manifest),
      manifestSha256: current.manifestSha256,
      count: current.sources.length,
      captureBlock: policy.captureBlock,
    },
    params: {
      ...params,
      encoded: encodedParams,
      paramsHash,
    },
    sourceQuotas: current.result.sourceAllocations.map(
      ({ sourceId, quota }) => ({
        sourceId,
        quota,
      })
    ),
    sourceAllocations: current.result.sourceAllocations,
    output: {
      entries: current.result.output,
      blob: toHex(Buffer.from(current.result.outputBlob)),
      blobSha256: current.result.outputBlobSha256,
      cid: current.result.outputCid,
      cidDigest: cidStringDigest(current.result.outputCid),
      root: current.result.outputRoot,
      totalValue: current.result.totalValue,
      sampleAccount: proof.sample.account,
      sampleValue: proof.sample.value,
      sampleLeaf: proof.sampleLeaf,
      sampleProof: proof.proof,
    },
    journal: {
      ...journal,
      encoded: encodedJournal,
      digest: keccak256(encodedJournal),
    },
    binding: { snapshot: SNAPSHOT, recipient: RECIPIENT, instanceDomain },
    postTriggerUpdate: {
      captureManifestSha256: next.manifestSha256,
      outputRoot: next.result.outputRoot,
    },
  })
}
