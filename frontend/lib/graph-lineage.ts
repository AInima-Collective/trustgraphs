import type { Address, Hex } from 'viem'

export class GraphLineageApiUnavailableError extends Error {
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
    if (response.status === 404 || response.status === 405)
      throw new GraphLineageApiUnavailableError(message, response.status)
    throw new Error(message)
  }
  return body as T
}

export type GraphConfiguration = {
  id: Hex
  lineageId: Hex
  version: string
  programId: Hex
  snapshot: Address
  verifier: Address
  registryOrAccumulator: Address
  paramsHash: Hex
  controller: Address
  authority: Address
  familyId: Hex
  methodId: Hex
  scopeHash: Hex
  identityDomain: Hex
  sourceLineagePolicyHash: Hex
  current: boolean
  activatedAt: string
  activatedBlock: string
  activatedTxHash: Hex
  supersededAtBlock: string | null
  authenticatedLive?: boolean
}

export type GraphLineage = {
  id: Hex
  chainId: string
  registry: Address
  instanceRegistry: Address
  instanceId: Hex
  familyId: Hex
  currentConfigurationId: Hex | null
  currentVersion: string
  authority: Address
  controller: Address
  displayName: string
  metadataURI: string
  createdBlock: string
  createdTimestamp: string
  updatedBlock: string
  updatedTimestamp: string
  currentConfiguration?: GraphConfiguration | null
  authenticatedLive?: boolean
}

export type GraphEpoch = {
  id: Hex
  lineageId: Hex
  configurationId: Hex
  configurationVersion: string
  checkpointId: string
  freezeBlock: string
  acceptedAtBlock: string
  root: Hex
  blobSha256: Hex
  cidDigest: Hex
  cid: string
  totalValue: string
  programVKey: Hex
  publishedBlock: string
  publishedTimestamp: string
  publishedTxHash: Hex
}

export type GraphEndorsement = {
  id: Hex
  registry: Address
  issuerLineageId: Hex
  subjectLineageId: Hex
  issuerConfigurationId: Hex
  subjectConfigurationId: Hex
  scopeHash: Hex
  kind: 'integrity' | 'methodology' | 'referral' | 'agreement' | 'warning'
  kindCode: number
  weight: string
  validFrom: string
  validUntil: string
  evidenceURI: string
  evidenceDigest: Hex
  evidenceMutable: boolean
  sequence: string
  supersedes: Hex | null
  supersededBy: Hex | null
  revokedAt: string | null
  revocationRef: Hex | null
  issuedBlock: string
  issuedTimestamp: string
  issuedTxHash: Hex
  status:
    | 'unknown'
    | 'active'
    | 'wrong-scope'
    | 'wrong-subject-configuration'
    | 'revoked'
    | 'superseded'
    | 'not-started'
    | 'expired'
    | 'issuer-configuration-rotated'
    | 'subject-configuration-rotated'
    | 'verification-unavailable'
  overlap: {
    family: boolean
    method: boolean
    controller: boolean
    authority: boolean
  } | null
}

export type ReferralEdge = {
  endorsementId: Hex
  issuerLineageId: Hex
  subjectLineageId: Hex
  scopeHash: Hex
  weight: string
  evidenceURI: string
  evidenceDigest: Hex
  evidenceMutable: boolean
  overlap: {
    family: boolean
    method: boolean
    controller: boolean
    authority: boolean
  }
}

export type ReferralBudget = {
  issuerLineageId: Hex
  scopeHash: Hex
  spent: string
  unused: string
}

export const fetchGraphLineages = async (
  api: string,
  signal?: AbortSignal
): Promise<GraphLineage[]> => {
  const response = await fetch(`${api}/graph-lineages/lineages?limit=500`, {
    signal,
  })
  return (await responseJson<{ items: GraphLineage[] }>(response)).items
}

export const fetchGraphLineage = async (
  api: string,
  lineageId: Hex,
  signal?: AbortSignal
) => {
  const response = await fetch(`${api}/graph-lineages/lineages/${lineageId}`, {
    signal,
  })
  return responseJson<{
    lineage: GraphLineage
    configurations: GraphConfiguration[]
    epochs: GraphEpoch[]
    authorityPolicy: string
  }>(response)
}

export const fetchGraphEndorsements = async (
  api: string,
  query: { issuer?: Hex; subject?: Hex; scopeHash?: Hex },
  signal?: AbortSignal
) => {
  const params = new URLSearchParams({ limit: '500' })
  if (query.issuer) params.set('issuer', query.issuer)
  if (query.subject) params.set('subject', query.subject)
  if (query.scopeHash) params.set('scopeHash', query.scopeHash)
  const response = await fetch(`${api}/graph-lineages/endorsements?${params}`, {
    signal,
  })
  return (await responseJson<{ items: GraphEndorsement[] }>(response)).items
}

export const fetchReferralDiagnostics = async (
  api: string,
  scopeHash: Hex,
  signal?: AbortSignal
) => {
  const response = await fetch(
    `${api}/graph-lineages/referrals?scopeHash=${scopeHash}`,
    { signal }
  )
  return responseJson<{
    scopeHash: Hex
    previousEpochOnly: true
    advisoryOnly: true
    edges: ReferralEdge[]
    budgets: ReferralBudget[]
    excluded: Array<{ endorsementId: Hex; status: string }>
    warning: string
  }>(response)
}
