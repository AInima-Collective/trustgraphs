import { formatUnits } from 'viem'

export const SCORE_DECIMALS = 18

export type ScoreboardExportEntry = {
  account: string
  value: string
  proof: string[]
  /** Live attestation counts, queried independently of the published score root. */
  received?: number
  sent?: number
}

type PublishedExportMetadata = {
  mode: 'published'
  snapshot: string
  root: string
  ipfsHashCid?: string
  scoresAsOf: {
    blockNumber: string
    /** Unix timestamp in seconds, exactly as recorded for the root. */
    timestamp: string
  }
  liveCountsFetchedAt?: string
}

export type SimulationExportProvenance = {
  kind:
    | 'reduced-lane-1-browser-recompute'
    | 'independent-envelope0-browser-recompute'
  inputDataFetchedAt?: string
  referencePublishedRoot?: string
  referencePublishedRootAsOf?: {
    blockNumber: string
    timestamp: string
  }
  params: {
    dampingFactor: number
    trustShare: number
    trustDecay: number
    maxIterations: number
    minWeight: number
    maxWeight: number
    trustedSeeds: string[]
    pointsPool: string
    precisionScale: string
    schemaUid?: string
    accumulator: string
    chainId: string
    envelope0DomainSeparators?: string[]
    lane2MaxHeadAge?: number
  }
  paramsHash: string
  inputAccumulator: string
  inputLeafCount: string
  envelope0Audit?: {
    registry: string
    nodes: number
    entries: number
    verifiedAt: string
  }
}

type SimulationExportMetadata = {
  mode: 'simulation'
  snapshot: string
  /** Locally recomputed root; it has not been published on-chain. */
  root: string
  ipfsHashCid?: string
  liveCountsFetchedAt?: string
  simulation: SimulationExportProvenance
}

export type ScoreboardExportMetadata =
  | PublishedExportMetadata
  | SimulationExportMetadata

export type ScoreboardExportInput = {
  data: ScoreboardExportEntry[]
  metadata: ScoreboardExportMetadata
}

const humanScore = (raw: string) => formatUnits(BigInt(raw), SCORE_DECIMALS)

const liveCountsMetadata = (fetchedAt?: string) => ({
  fetchedAt: fetchedAt ?? null,
  committedToMerkleRoot: false,
  description:
    'Received and sent are live indexer counts and are not committed to the score Merkle root.',
})

export const createScoreboardExportDocument = (
  { data, metadata }: ScoreboardExportInput,
  exportedAt = new Date().toISOString()
) => ({
  schemaVersion: 'trustgraphs-scoreboard-v1',
  exportDate: exportedAt,
  mode: metadata.mode,
  snapshot: metadata.snapshot,
  merkleRoot: metadata.root,
  rootStatus:
    metadata.mode === 'published'
      ? 'published'
      : 'local-simulation-not-published',
  scoreEncoding: {
    decimals: SCORE_DECIMALS,
    humanField: 'score',
    exactField: 'scoreRaw',
  },
  scoresAsOf:
    metadata.mode === 'published'
      ? {
          blockNumber: metadata.scoresAsOf.blockNumber,
          unixTimestamp: metadata.scoresAsOf.timestamp,
        }
      : null,
  ipfsHashCid: metadata.ipfsHashCid ?? null,
  liveAttestationCounts: liveCountsMetadata(metadata.liveCountsFetchedAt),
  ...(metadata.mode === 'simulation'
    ? { simulation: metadata.simulation }
    : {}),
  totalParticipants: data.length,
  network: data.map((entry, index) => ({
    rank: index + 1,
    account: entry.account,
    receivedLive: entry.received ?? 0,
    sentLive: entry.sent ?? 0,
    score: humanScore(entry.value),
    scoreRaw: entry.value,
    proof: entry.proof,
  })),
})

export const serializeScoreboardJSON = (
  input: ScoreboardExportInput,
  exportedAt?: string
) => JSON.stringify(createScoreboardExportDocument(input, exportedAt), null, 2)

const csvField = (value: string | number) =>
  `"${String(value).replace(/"/g, '""')}"`

/**
 * CSV repeats root/provenance fields on every row. That keeps the file a normal one-header CSV
 * while ensuring a detached or filtered row still says what its proof and score are against.
 */
export const serializeScoreboardCSV = (
  { data, metadata }: ScoreboardExportInput,
  exportedAt = new Date().toISOString()
) => {
  const headers = [
    'Mode',
    'Root Status',
    'Snapshot',
    'Merkle Root',
    'Scores As Of (Unix Seconds)',
    'Root Block Number',
    'Exported At',
    'Live Counts Fetched At',
    'Rank',
    'Account',
    'Received (Live, Not In Root)',
    'Sent (Live, Not In Root)',
    'Score',
    'Score Raw',
    'Score Decimals',
    'Merkle Proof',
    'IPFS CID',
    'Simulation Params Hash',
    'Simulation Provenance',
  ]

  const publishedAsOf =
    metadata.mode === 'published' ? metadata.scoresAsOf : undefined
  const rows = data.map((entry, index) => [
    metadata.mode,
    metadata.mode === 'published'
      ? 'published'
      : 'local-simulation-not-published',
    metadata.snapshot,
    metadata.root,
    publishedAsOf?.timestamp ?? '',
    publishedAsOf?.blockNumber ?? '',
    exportedAt,
    metadata.liveCountsFetchedAt ?? '',
    index + 1,
    entry.account,
    entry.received ?? 0,
    entry.sent ?? 0,
    humanScore(entry.value),
    entry.value,
    SCORE_DECIMALS,
    JSON.stringify(entry.proof),
    metadata.ipfsHashCid ?? '',
    metadata.mode === 'simulation' ? metadata.simulation.paramsHash : '',
    metadata.mode === 'simulation' ? JSON.stringify(metadata.simulation) : '',
  ])

  return [headers, ...rows]
    .map((row) => row.map((field) => csvField(field)).join(','))
    .join('\n')
}
