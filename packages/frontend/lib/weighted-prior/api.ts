import type { Hex } from 'viem'

export interface WeightedApiAvailability {
  status: 'available' | 'degraded' | 'unavailable'
  provenance: 'cache' | 'mirror' | 'transaction' | 'unavailable'
  sourceTxHash: Hex
  error: string | null
  verifiedAt: string | null
}

export interface WeightedApiVersion {
  instanceId: Hex
  controller: Hex
  version: string
  status: 'pending' | 'active' | 'superseded' | 'cancelled' | 'inconsistent'
  commitments: {
    paramsHash: Hex
    previousParamsHash: Hex | null
    priorRoot: Hex
    priorCount: number
    manifestSha256: Hex
    manifestCid: string
    metadataDigest: Hex
  }
  readyAt: string | null
  availability: WeightedApiAvailability
}

export interface WeightedApiEntry {
  position: number
  account: Hex
  normalizedWeight: string
}

export interface WeightedApiInstance {
  id: Hex
  name: string
  metadata?: {
    name?: string
    description?: string
    criteria?: string
    image?: string
    applicationUrl?: string
  } | null
}

export interface WeightedApiInstanceDetail extends WeightedApiInstance {
  program: 'trust-graph-weighted'
  chainId: string
  factory: Hex
  controller: Hex | null
  creator: Hex
  admin: Hex
  metadataURI: string
  resolver: Hex
  schemaUid: Hex
  snapshot: Hex
  distributor: Hex | null
  distributorToken: Hex | null
  governance: {
    module: Hex
    safe: Hex
  } | null
  epochLength: string
  currentVersion: string
  currentParamsHash: Hex
  params: {
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
    accumulator: Hex
    chainId: string
  }
  metadataDigest: Hex
  createdBlock: string
  createdTimestamp: string
  createdTxHash: Hex
}

const responseJson = async <T>(response: Response): Promise<T> => {
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(
      body?.error || `Indexer request failed (${response.status}).`
    )
  }
  return body as T
}

export const fetchWeightedVersions = async (
  api: string,
  instanceId: Hex,
  signal?: AbortSignal
): Promise<WeightedApiVersion[]> => {
  const response = await fetch(
    `${api}/weighted-priors/${instanceId}/versions?limit=200`,
    { signal }
  )
  return (await responseJson<{ versions: WeightedApiVersion[] }>(response))
    .versions
}

/** List every weighted instance available for review or rotation on the indexed chain. */
export const fetchWeightedInstances = async (
  api: string,
  signal?: AbortSignal
): Promise<WeightedApiInstance[]> => {
  const instances: WeightedApiInstance[] = []
  for (let offset = 0; ; ) {
    const response = await fetch(
      `${api}/weighted-priors?limit=200&offset=${offset}`,
      { signal }
    )
    const page = await responseJson<{
      instances: WeightedApiInstance[]
      page: { total: number }
    }>(response)
    instances.push(...page.instances)
    if (instances.length >= page.page.total || page.instances.length === 0)
      return instances
    offset += page.instances.length
  }
}

export const fetchWeightedInstance = async (
  api: string,
  instanceId: Hex,
  signal?: AbortSignal
): Promise<WeightedApiInstanceDetail> => {
  const response = await fetch(`${api}/weighted-priors/${instanceId}`, {
    signal,
  })
  return (await responseJson<{ instance: WeightedApiInstanceDetail }>(response))
    .instance
}

export const fetchWeightedEntries = async (
  api: string,
  instanceId: Hex,
  version: string,
  signal?: AbortSignal
): Promise<WeightedApiEntry[]> => {
  const entries: WeightedApiEntry[] = []
  for (let offset = 0; ; offset += 500) {
    const response = await fetch(
      `${api}/weighted-priors/${instanceId}/versions/${version}/entries?limit=500&offset=${offset}`,
      { signal }
    )
    const page = await responseJson<{
      entries: WeightedApiEntry[]
      page: { total: number }
    }>(response)
    entries.push(...page.entries)
    if (entries.length >= page.page.total || page.entries.length === 0) break
  }
  return entries
}

export const fetchBinarySeeds = async (
  api: string,
  instanceId: Hex,
  signal?: AbortSignal
): Promise<Hex[]> => {
  const response = await fetch(`${api}/instances/${instanceId}`, { signal })
  const body = await responseJson<{
    instance: { params?: { trustedSeeds?: Hex[] }; trustedSeeds?: Hex[] }
  }>(response)
  return body.instance.params?.trustedSeeds ?? body.instance.trustedSeeds ?? []
}

export const availabilityDiagnosis = (
  availability: WeightedApiAvailability
): string | null => {
  if (availability.status === 'available') return null
  if (availability.status === 'degraded') {
    return `The exact manifest is available from ${availability.provenance}, but another configured source is degraded${availability.error ? `: ${availability.error}` : '.'}`
  }
  return `The indexer cannot recover the exact committed manifest from transaction ${availability.sourceTxHash}${availability.error ? `: ${availability.error}` : '.'} Rotation review is disabled until those bytes are available.`
}
