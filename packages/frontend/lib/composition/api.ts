import type { Address, Hex } from 'viem'

import { cidV1Raw, digestToHex, sha256Utf8 } from '../pagerank/cid'
import { ZERO_HASH } from '../pagerank/words'
import {
  SCORE_OUTPUT_DOMAIN_IDS,
  SCORE_PROGRAM_IDS,
  type ScoreProgramName,
  parseScoreProgramProvenance,
} from '../score-program'
import {
  type CompositionEntry,
  type CompositionSource,
  canonicalCompositionBlob,
  compositionOutputRoot,
  compositionSourceId,
  sourceReviewDigest,
  suggestedFamilyId,
} from './core'

export class CompositionApiUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

const responseJson = async <T>(response: Response): Promise<T> => {
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      body?.error || `Indexer request failed (${response.status}).`
    if (response.status === 404 || response.status === 405) {
      throw new CompositionApiUnavailableError(message, response.status)
    }
    throw new Error(message)
  }
  return body as T
}

export type CompositionCandidate = {
  instanceId: Hex
  name: string
  chainId: string
  snapshot: Address
  controller: Address | null
  programId: Hex
  programName: ScoreProgramName
  outputDomain: Hex
  keyEncoding: 'eip155-address' | 'bytes32'
  registry: Address | null
  verifier: Address | null
  paramsHash: Hex
  createdTimestamp: string
}

type CatalogInstance = {
  id: Hex
  name: string
  chainId: string
  createdTimestamp: string
  paramsHash: Hex
  contracts: {
    merkleSnapshot: Address
    trustgraphsParamsController: Address | null
  }
  scoreProgram: unknown
}

type WeightedInstance = {
  id: Hex
  name: string
  chainId: string
  snapshot: Address
  controller: Address | null
  currentParamsHash: Hex
  createdTimestamp: string
}

const collectPages = async <T>({
  url,
  key,
  pageKey,
  signal,
}: {
  url: string
  key: string
  pageKey: string
  signal?: AbortSignal
}): Promise<T[]> => {
  const rows: T[] = []
  for (let offset = 0; ; offset += 200) {
    const separator = url.includes('?') ? '&' : '?'
    const response = await fetch(
      `${url}${separator}limit=200&offset=${offset}`,
      { signal }
    )
    const body = await responseJson<Record<string, any>>(response)
    const pageRows = (body[key] ?? []) as T[]
    rows.push(...pageRows)
    const page = body[pageKey] as { total?: number } | undefined
    if (pageRows.length === 0 || rows.length >= (page?.total ?? rows.length)) {
      return rows
    }
  }
}

export const fetchCompositionCandidates = async (
  api: string,
  signal?: AbortSignal
): Promise<{
  candidates: CompositionCandidate[]
  warnings: string[]
}> => {
  const warnings: string[] = []
  const regular = await collectPages<CatalogInstance>({
    url: `${api}/instances`,
    key: 'instances',
    pageKey: 'pagination',
    signal,
  })
  let weighted: WeightedInstance[] = []
  try {
    weighted = await collectPages<WeightedInstance>({
      url: `${api}/weighted-priors`,
      key: 'instances',
      pageKey: 'page',
      signal,
    })
  } catch (error) {
    if (!(error instanceof CompositionApiUnavailableError)) throw error
    warnings.push(
      'The weighted-prior catalog is not deployed on this indexer yet; compatible weighted sources are temporarily hidden.'
    )
  }

  const candidates = regular
    .map((row): CompositionCandidate | null => {
      const program = parseScoreProgramProvenance(row.scoreProgram)
      if (program.keyEncoding !== 'eip155-address') return null
      if (
        program.programName !== 'trust-graph' &&
        program.programName !== 'trust-graph-weighted'
      ) {
        return null
      }
      return {
        instanceId: row.id,
        name: row.name,
        chainId: row.chainId,
        snapshot: row.contracts.merkleSnapshot,
        controller: row.contracts.trustgraphsParamsController,
        programId: program.programId,
        programName: program.programName,
        outputDomain: program.outputDomain,
        keyEncoding: program.keyEncoding,
        registry: program.source.registry,
        verifier: program.verifier,
        paramsHash: program.paramsHash,
        createdTimestamp: row.createdTimestamp,
      }
    })
    .filter((value): value is CompositionCandidate => !!value)

  candidates.push(
    ...weighted.map((row) => ({
      instanceId: row.id,
      name: row.name,
      chainId: row.chainId,
      snapshot: row.snapshot,
      controller: row.controller,
      programId: SCORE_PROGRAM_IDS['trust-graph-weighted'],
      programName: 'trust-graph-weighted' as const,
      outputDomain: SCORE_OUTPUT_DOMAIN_IDS['weighted-trust-graph-account-v1'],
      keyEncoding: 'eip155-address' as const,
      registry: null,
      verifier: null,
      paramsHash: row.currentParamsHash,
      createdTimestamp: row.createdTimestamp,
    }))
  )

  const deduplicated = new Map<string, CompositionCandidate>()
  for (const candidate of candidates) {
    deduplicated.set(candidate.snapshot.toLowerCase(), candidate)
  }
  return {
    candidates: [...deduplicated.values()].sort((left, right) =>
      BigInt(left.createdTimestamp) > BigInt(right.createdTimestamp) ? -1 : 1
    ),
    warnings,
  }
}

export type SourceEligibility = {
  status: 'ready' | 'awaiting-root' | 'enableable' | 'locked' | 'unknown'
  detail: string | null
}

/**
 * Classify a candidate's on-chain compose-source eligibility so the picker can say up front why a
 * network is not selectable, instead of erroring after a click. `enableStateProvenance()` is
 * one-way and only callable while a snapshot has zero accepted states, which is what makes the
 * 'locked' verdict permanent rather than a retry-later condition.
 */
export const classifySourceEligibility = (
  provenanceEnabled: boolean,
  stateCount: bigint
): SourceEligibility => {
  if (provenanceEnabled && stateCount > 0n)
    return { status: 'ready', detail: null }
  if (provenanceEnabled) {
    return {
      status: 'awaiting-root',
      detail:
        'Provenance history is on. This network can be added once its first accepted score root lands.',
    }
  }
  if (stateCount === 0n) {
    return {
      status: 'enableable',
      detail:
        "Not selectable yet: this network's accepted-state provenance is off. Its constitutional authority can still enable it, but only before the first accepted score root lands.",
    }
  }
  return {
    status: 'locked',
    detail:
      'Permanently ineligible: a score root landed before accepted-state provenance was enabled, and the history can only be started before the first root.',
  }
}

export type CompositionSourceChainState = {
  provenanceEnabled: boolean
  stateIndex: bigint
  checkpointId: bigint
  acceptedAtBlock: bigint
  freezeBlock: bigint
  outputRoot: Hex
  blobSha256: Hex
  cid: string
  totalValue: bigint
  verifier: Address
  paramsHash: Hex
}

type MerkleResponse = {
  tree: {
    root: Hex
    ipfsHash: Hex
    ipfsHashCid: string
    numAccounts: number
    totalValue: string
    blockNumber: string
    timestamp: string
  }
  entries: Array<{
    account: Address
    value: string
    proof: Hex[]
  }>
  scoreProgram: unknown
}

export const fetchCompositionSource = async ({
  api,
  candidate,
  chain,
  familyId,
  adapter = null,
  signal,
}: {
  api: string
  candidate: CompositionCandidate
  chain: CompositionSourceChainState
  familyId?: Hex
  adapter?: Address | null
  signal?: AbortSignal
}): Promise<CompositionSource> => {
  if (!chain.provenanceEnabled) {
    throw new Error(
      `${candidate.name} did not enable accepted-state provenance before its current root.`
    )
  }
  const response = await fetch(`${api}/merkle/${candidate.snapshot}/current`, {
    signal,
  })
  const body = await responseJson<MerkleResponse>(response)
  const program = parseScoreProgramProvenance(body.scoreProgram)
  if (program.keyEncoding !== 'eip155-address') {
    throw new Error(`${candidate.name} is not an address allocation output.`)
  }
  for (const [label, left, right] of [
    ['instance', program.instanceId, candidate.instanceId],
    ['program', program.programId, candidate.programId],
    ['output domain', program.outputDomain, candidate.outputDomain],
    ['verifier', program.verifier, chain.verifier],
    ['parameters', program.paramsHash, chain.paramsHash],
    ['root', body.tree.root, chain.outputRoot],
    ['blob digest', body.tree.ipfsHash, chain.blobSha256],
  ] as const) {
    if (left.toLowerCase() !== right.toLowerCase()) {
      throw new Error(
        `${candidate.name} ${label} differs between indexer and accepted on-chain provenance.`
      )
    }
  }
  if (
    body.tree.ipfsHashCid !== chain.cid ||
    BigInt(body.tree.totalValue) !== chain.totalValue ||
    // merkle_metadata.blockNumber is the MerkleRootUpdated/proof-acceptance block. The snapshot's
    // MerkleState.blockNumber is intentionally the earlier input-freeze block; comparing those two
    // made every composition source fail whenever proof generation took more than zero blocks.
    BigInt(body.tree.blockNumber) !== chain.acceptedAtBlock
  ) {
    throw new Error(
      `${candidate.name} current tree metadata differs from its accepted on-chain state.`
    )
  }
  const entries: CompositionEntry[] = body.entries
    .map((entry) => ({
      account: entry.account.toLowerCase() as Address,
      value: BigInt(entry.value),
    }))
    .sort((left, right) => left.account.localeCompare(right.account))
  if (entries.length !== body.tree.numAccounts) {
    throw new Error(`${candidate.name} current entry page is incomplete.`)
  }
  const blob = canonicalCompositionBlob(entries)
  const blobDigest = sha256Utf8(blob)
  if (
    digestToHex(blobDigest).toLowerCase() !== chain.blobSha256.toLowerCase() ||
    cidV1Raw(blobDigest) !== chain.cid
  ) {
    throw new Error(
      `${candidate.name} entries do not reproduce its canonical blob commitment.`
    )
  }
  if (
    compositionOutputRoot(entries).toLowerCase() !==
    chain.outputRoot.toLowerCase()
  ) {
    throw new Error(`${candidate.name} entries do not reproduce its root.`)
  }
  const sourceId = compositionSourceId(candidate.instanceId, candidate.snapshot)
  const sourceFamily =
    familyId ??
    suggestedFamilyId(
      program.programId,
      candidate.controller ??
        ('0x0000000000000000000000000000000000000000' as Address)
    )
  const source: CompositionSource = {
    instanceId: candidate.instanceId,
    name: candidate.name,
    chainId: BigInt(candidate.chainId),
    sourceId,
    snapshot: candidate.snapshot,
    familyId: sourceFamily,
    programId: program.programId,
    controller:
      candidate.controller ??
      ('0x0000000000000000000000000000000000000000' as Address),
    registry: program.source.registry,
    verifier: program.verifier,
    paramsHash: program.paramsHash,
    adapter,
    deploymentProvenance: ZERO_HASH,
    stateIndex: chain.stateIndex,
    checkpointId: chain.checkpointId,
    acceptedAtBlock: chain.acceptedAtBlock,
    freezeBlock: chain.freezeBlock,
    outputRoot: chain.outputRoot.toLowerCase() as Hex,
    blobSha256: chain.blobSha256.toLowerCase() as Hex,
    cid: chain.cid,
    totalValue: chain.totalValue,
    weight: 0n,
    maxAgeBlocks: 1_000n,
    entries,
    available: true,
    availabilityError: null,
  }
  source.deploymentProvenance = sourceReviewDigest(source)
  // Force UTF-8 materialization here. It catches environments missing TextEncoder before a user
  // reaches transaction review, and documents that the exact canonical bytes were recovered.
  new TextEncoder().encode(blob)
  return source
}

export type CompositionPolicy = {
  id: string
  instanceId: Hex
  controller: Address
  version: string
  status: 'pending' | 'active' | 'superseded' | 'cancelled' | 'inconsistent'
  paramsHash: Hex
  previousParamsHash: Hex | null
  params: Record<string, unknown>
  proposalId: Hex | null
  sourcePolicyRoot: Hex
  sourceCount: number
  manifestSha256: Hex
  adapterSetHash: Hex
  metadataDigest: Hex
  policyManifest: Hex | null
  sources: Array<Record<string, unknown>>
  adapters: Address[]
  readyAt: string | null
  proposedBlock: string
  proposedTimestamp: string
  proposedTxHash: Hex
  activatedBlock: string | null
  activatedTimestamp: string | null
  activatedTxHash: Hex | null
  firstCheckpoint: string | null
  availability: 'available' | 'degraded' | 'unavailable'
  availabilityError: string | null
  provenance: {
    cryptographic: Record<string, unknown>
    governance: Record<string, unknown>
    availability: { status: string; error: string | null }
  }
}

export type CompositionInstance = {
  id: Hex
  chainId: string
  controller: Address | null
  creator: Address
  admin: Address
  name: string
  metadataURI: string
  metadataURIHash: Hex
  metadataRevision: string
  metadataStatus: string
  metadataUpdated: {
    block: string
    timestamp: string
    txHash: Hex
  }
  metadata?: {
    name: string
    description: string
    criteria: string
    image: string
    applicationUrl: string
  } | null
  governance: {
    module: Address
    safe: Address
    recoveryModule?: Address | null
    executionGuard?: Address | null
  } | null
  accumulator: Address
  snapshot: Address
  distributor: Address | null
  epochLength: string
  programVKey: Hex
  currentVersion: string
  currentParamsHash: Hex
  params: Record<string, unknown>
  metadataDigest: Hex
  createdBlock: string
  createdTimestamp: string
  createdTxHash: Hex
  program: 'trust-compose'
}

export type CompositionEpoch = {
  merkleSnapshotContract: Address
  root: Hex
  instanceId: Hex
  checkpointId: string
  policyVersion: string
  paramsHash: Hex
  captureManifestSha256: Hex
  outputBlobSha256: Hex
  outputCid: string
  totalValue: string
  work: Record<string, unknown>
  metrics: Record<string, unknown>
  cryptographicProvenance: Record<string, unknown>
  governanceProvenance: Record<string, unknown>
  verifiedAt: string
  blockNumber: string
  timestamp: string
}

export type CompositionSourceEvidence = {
  sourceId: Hex
  position: number
  snapshot: Address
  familyId: Hex
  programId: Hex
  adapter: Address
  deploymentProvenance: Hex
  stateIndex: string
  sourceCheckpointId: string
  freezeBlock: string
  outputRoot: Hex
  blobSha256: Hex
  cid: string
  totalValue: string
  weight: string
  maxAgeBlocks: string
  quota: string
  entryCount: number
  blobBytes: number
  cryptographicallyBound: boolean
  governanceAdmitted: boolean
}

export type CompositionAttributionEvidence = {
  sourceId: Hex
  account: Address
  exactValue: string
  idealNumerator: string
  idealDenominator: string
  roundingDeltaNumerator: string
}

export type CompositionOutputEntry = {
  account: Address
  value: string
  proof: Hex[]
}

export type CompositionBundle = {
  instance: CompositionInstance
  policy: CompositionPolicy
  capture: Record<string, unknown>
  epoch: CompositionEpoch
  sources: CompositionSourceEvidence[]
  attribution: CompositionAttributionEvidence[]
  outputEntries: CompositionOutputEntry[]
  provenance: {
    cryptographic: Record<string, unknown>
    governance: Record<string, unknown>
  }
}

const pageAll = async <T>(
  url: string,
  key: string,
  signal?: AbortSignal
): Promise<T[]> => {
  const rows: T[] = []
  for (let offset = 0; ; offset += 500) {
    const separator = url.includes('?') ? '&' : '?'
    const response = await fetch(
      `${url}${separator}limit=500&offset=${offset}`,
      { signal }
    )
    const body = await responseJson<Record<string, any>>(response)
    const next = (body[key] ?? []) as T[]
    rows.push(...next)
    if (
      next.length === 0 ||
      rows.length >= Number(body.page?.total ?? rows.length)
    ) {
      return rows
    }
  }
}

export const fetchCompositionInstances = (api: string, signal?: AbortSignal) =>
  pageAll<CompositionInstance>(`${api}/compositions`, 'instances', signal)

export const fetchCompositionPolicies = (
  api: string,
  instanceId: Hex,
  signal?: AbortSignal
) =>
  pageAll<CompositionPolicy>(
    `${api}/compositions/${instanceId}/policies`,
    'policies',
    signal
  )

export const fetchCompositionEpochs = (
  api: string,
  instanceId: Hex,
  signal?: AbortSignal
) =>
  pageAll<CompositionEpoch>(
    `${api}/compositions/${instanceId}/epochs`,
    'epochs',
    signal
  )

export const fetchCompositionBundle = async (
  api: string,
  instanceId: Hex,
  checkpointId: string,
  signal?: AbortSignal
): Promise<CompositionBundle> => {
  const response = await fetch(
    `${api}/compositions/${instanceId}/epochs/${checkpointId}/bundle`,
    { signal }
  )
  return responseJson<CompositionBundle>(response)
}

export const fetchCompositionOverview = async (
  api: string,
  instanceId: Hex,
  signal?: AbortSignal
) => {
  const [instances, policies, epochs] = await Promise.all([
    fetchCompositionInstances(api, signal),
    fetchCompositionPolicies(api, instanceId, signal),
    fetchCompositionEpochs(api, instanceId, signal),
  ])
  const instance = instances.find(
    (candidate) => candidate.id.toLowerCase() === instanceId.toLowerCase()
  )
  if (!instance) throw new Error('Composition instance not found.')
  return { instance, policies, epochs }
}

export const requireCompatibleCandidate = (
  candidate: CompositionCandidate,
  selected: CompositionCandidate[]
) => {
  if (candidate.keyEncoding !== 'eip155-address') {
    throw new Error('Only address-keyed allocation outputs are compatible.')
  }
  if (selected.length === 0) return
  const first = selected[0]!
  if (candidate.chainId !== first.chainId) {
    throw new Error('All composition sources must be on the same chain.')
  }
  if (candidate.programId.toLowerCase() !== first.programId.toLowerCase()) {
    throw new Error(
      'V1 requires one admitted score program; choose sources with identical program semantics.'
    )
  }
}
