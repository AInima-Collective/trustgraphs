import { Buffer } from 'node:buffer'

import {
  encodeAbiParameters,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from 'viem'

import {
  incompatibleThirdProgramPolicy,
  mixedFixturePolicy,
  reversedMixedFixturePolicy,
  rotatedMixedFixturePolicy,
} from './fixture-builder-v2'
import { cidStringDigest, outputLeaf, sha256Hex } from './reference'
import {
  ADMITTED_PAIRS,
  COMPOSE_PROGRAM_ID,
  SOURCE_COMPATIBILITY_CLASS_V1,
  TRUST_GRAPH_OUTPUT_DOMAIN,
  TRUST_GRAPH_PROGRAM_ID,
  WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN,
  WEIGHTED_TRUST_GRAPH_PROGRAM_ID,
  canonicalManifestV2,
  canonicalPolicyManifestV2,
  composeV2,
  sourcePolicyLeafV2,
  sourcePolicyRootV2,
  type CompositionPolicyV2,
} from './reference-v2'
import {
  IDENTITY_DOMAIN,
  MAX_SOURCE_AGE_BLOCKS,
  OUTPUT_DOMAIN,
  OUTPUT_KIND,
  PROGRAM_ID,
} from './production'

const ACCUMULATOR = `0x${'c0'.repeat(20)}` as Address
const RECIPIENT = `0x${'d1'.repeat(20)}` as Address
const INSTANCE_DOMAIN = `0x${'d2'.repeat(32)}` as Hex
const ZERO_WORD = `0x${'00'.repeat(32)}` as Hex

export type ProductionParamsV2 = {
  version: number
  programId: Hex
  scopeHash: Hex
  identityDomain: Hex
  outputKind: Hex
  outputDomain: Hex
  sourceCompatibilityClass: Hex
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

export const paramsEncodedV2 = (params: ProductionParamsV2): Hex =>
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
      params.sourceCompatibilityClass,
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

export type ProductionJournalV2 = {
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

export const journalEncodedV2 = (journal: ProductionJournalV2): Hex =>
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

const hashPair = (left: Hex, right: Hex): Hex =>
  keccak256(
    Buffer.concat(
      (left <= right ? [left, right] : [right, left]).map((value) =>
        Buffer.from(value.slice(2), 'hex')
      )
    )
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

const bigintStrings = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item
    )
  ) as T

const orderedSources = (policy: CompositionPolicyV2) =>
  [...policy.sources].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId)
  )

const paramsFor = (policy: CompositionPolicyV2): ProductionParamsV2 => {
  const sources = orderedSources(policy)
  const policyManifest = canonicalPolicyManifestV2(policy.chainId, sources)
  return {
    version: 1,
    programId: PROGRAM_ID,
    scopeHash: policy.scopeHash,
    identityDomain: IDENTITY_DOMAIN,
    outputKind: OUTPUT_KIND,
    outputDomain: OUTPUT_DOMAIN,
    sourceCompatibilityClass: policy.sourceCompatibilityClass,
    weightScale: policy.weightScale,
    outputPool: policy.outputPool,
    sourcePolicyRoot: sourcePolicyRootV2(sources),
    sourceCount: sources.length,
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
}

const commitmentsFor = (policy: CompositionPolicyV2) => {
  const sources = orderedSources(policy)
  const result = composeV2(policy)
  const policyManifest = canonicalPolicyManifestV2(policy.chainId, sources)
  const captureManifest = canonicalManifestV2(policy, sources)
  const params = paramsFor(policy)
  const encodedParams = paramsEncodedV2(params)
  return {
    sources,
    result,
    policyManifest,
    captureManifest,
    params,
    encodedParams,
    paramsHash: keccak256(encodedParams),
  }
}

export const productionGoldenV2 = () => {
  const policy = mixedFixturePolicy()
  const current = commitmentsFor(policy)
  const reversed = commitmentsFor(reversedMixedFixturePolicy())
  const rotated = commitmentsFor(rotatedMixedFixturePolicy())

  if (
    toHex(reversed.captureManifest) !== toHex(current.captureManifest) ||
    reversed.paramsHash !== current.paramsHash ||
    reversed.result.outputRoot !== current.result.outputRoot
  ) {
    throw new Error('reversed source enumeration changed the canonical result')
  }

  const journal: ProductionJournalV2 = {
    acc: sha256Hex(current.captureManifest),
    leafCount: BigInt(current.sources.length),
    anchorAcc: ZERO_WORD,
    anchorCount: 0n,
    paramsHash: current.paramsHash,
    outputRoot: current.result.outputRoot,
    ipfsHash: current.result.outputBlobSha256,
    cidDigest: cidStringDigest(current.result.outputCid),
    totalValue: current.result.totalValue,
    skippedDigest: ZERO_WORD,
    recipient: RECIPIENT,
    instanceDomain: INSTANCE_DOMAIN,
  }
  const encodedJournal = journalEncodedV2(journal)
  const proof = outputProof(current.result.output, 1)

  return bigintStrings({
    schema: 'trust-compose',
    constants: {
      programId: PROGRAM_ID,
      identityDomain: IDENTITY_DOMAIN,
      outputKind: OUTPUT_KIND,
      outputDomain: OUTPUT_DOMAIN,
      sourceCompatibilityClass: SOURCE_COMPATIBILITY_CLASS_V1,
      weightScale: policy.weightScale,
      admittedPairs: [...ADMITTED_PAIRS].map(([programId, domain]) => ({
        programId,
        sourceOutputDomain: domain,
      })),
    },
    sourceStates: current.sources.map((source) => ({
      sourceId: source.sourceId,
      programId: source.programId,
      sourceOutputDomain: source.sourceOutputDomain,
      blob: source.blob,
      blobSha256: source.blobSha256,
      cid: source.cid,
      cidDigest: cidStringDigest(source.cid),
      outputRoot: source.outputRoot,
      totalValue: source.totalValue,
    })),
    policyManifest: {
      encoded: toHex(current.policyManifest),
      sha256: sha256Hex(current.policyManifest),
      root: current.params.sourcePolicyRoot,
      leaves: current.sources.map(sourcePolicyLeafV2),
      entries: current.sources.map((source) => ({
        sourceId: source.sourceId,
        snapshot: source.snapshot,
        familyId: source.familyId,
        programId: source.programId,
        sourceOutputDomain: source.sourceOutputDomain,
        weight: source.weight,
        maxAgeBlocks: source.maxAgeBlocks,
        required: source.required,
      })),
      count: current.sources.length,
    },
    capture: {
      manifest: toHex(current.captureManifest),
      manifestSha256: sha256Hex(current.captureManifest),
      count: current.sources.length,
      captureBlock: policy.captureBlock,
    },
    params: {
      ...current.params,
      encoded: current.encodedParams,
      paramsHash: current.paramsHash,
    },
    sourceQuotas: current.result.sourceAllocations.map(
      ({ sourceId, quota }) => ({ sourceId, quota })
    ),
    sourceAllocations: current.result.sourceAllocations,
    output: {
      entries: current.result.output,
      blob: current.result.outputBlob,
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
    binding: {
      accumulator: ACCUMULATOR,
      recipient: RECIPIENT,
      instanceDomain: INSTANCE_DOMAIN,
    },
    rotation: {
      weights: rotated.sources.map((source) => ({
        sourceId: source.sourceId,
        weight: source.weight,
      })),
      policyManifest: toHex(rotated.policyManifest),
      policyManifestSha256: sha256Hex(rotated.policyManifest),
      sourcePolicyRoot: rotated.params.sourcePolicyRoot,
      paramsHash: rotated.paramsHash,
      outputRoot: rotated.result.outputRoot,
      sourceQuotas: rotated.result.sourceAllocations.map(
        ({ sourceId, quota }) => ({ sourceId, quota })
      ),
    },
    rejections: {
      incompatibleThirdProgram: {
        programId: incompatibleThirdProgramPolicy().sources[2]!.programId,
        sourceOutputDomain:
          incompatibleThirdProgramPolicy().sources[2]!.sourceOutputDomain,
        error: 'program is not in the compatibility class',
      },
      crossedPairStandardDomain: {
        programId: incompatibleThirdProgramPolicy().sources[2]!.programId,
        sourceOutputDomain: TRUST_GRAPH_OUTPUT_DOMAIN,
        error: 'program is not in the compatibility class',
      },
      crossedPairWeightedDomain: {
        programId: incompatibleThirdProgramPolicy().sources[2]!.programId,
        sourceOutputDomain: WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN,
        error: 'program is not in the compatibility class',
      },
      standardProgramWeightedDomain: {
        programId: TRUST_GRAPH_PROGRAM_ID,
        sourceOutputDomain: WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN,
        error: 'output domain does not match its program',
      },
      weightedProgramStandardDomain: {
        programId: WEIGHTED_TRUST_GRAPH_PROGRAM_ID,
        sourceOutputDomain: TRUST_GRAPH_OUTPUT_DOMAIN,
        error: 'output domain does not match its program',
      },
      composeProgram: {
        programId: COMPOSE_PROGRAM_ID,
        sourceOutputDomain: TRUST_GRAPH_OUTPUT_DOMAIN,
        error: 'composite source',
      },
    },
  })
}
