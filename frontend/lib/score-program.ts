import { type Hex, keccak256, stringToHex } from 'viem'

/**
 * Consensus-facing score program names. These are identifiers, not catalog labels: their bytes32
 * values are the exact `InstanceRegistry.Instance.program` values written by deployers/factories.
 */
export const SCORE_PROGRAM_IDS = {
  'trust-graph': keccak256(stringToHex('trust-graph')),
  'trust-graph-weighted': keccak256(stringToHex('trust-graph-weighted')),
  contributions: keccak256(stringToHex('contributions')),
  hypercerts: keccak256(stringToHex('hypercerts')),
  'trust-compose': keccak256(stringToHex('trust-compose')),
  'nostr-workspace': keccak256(stringToHex('nostr-workspace')),
  'agent-reputation': keccak256(stringToHex('agent-reputation')),
} as const satisfies Record<string, Hex>

/**
 * Stable semantic output-key domains. Programs that happen to use the same byte width remain
 * distinct: a contributions recipient is not silently interchangeable with a TrustGraph account,
 * and a Hypercerts node is not an ERC-8004 agent.
 */
export const SCORE_OUTPUT_DOMAIN_IDS = {
  'trust-graph-account-v1': keccak256(
    stringToHex('trustgraphs.output.trust-graph-account.v1')
  ),
  'weighted-trust-graph-account-v1': keccak256(
    stringToHex('trustgraphs.output.weighted-trust-graph-account.v1')
  ),
  'contributions-recipient-v1': keccak256(
    stringToHex('trustgraphs.output.contributions-recipient.v1')
  ),
  'contributions-claim-v1': keccak256(
    stringToHex('trustgraphs.output.contributions-claim.v1')
  ),
  'hypercerts-node-v1': keccak256(
    stringToHex('trustgraphs.output.hypercerts-node.v1')
  ),
  'trust-compose-account-v1': keccak256(
    stringToHex('trustgraphs.output.trust-compose-account.v1')
  ),
  'nostr-member-v1': keccak256(
    stringToHex('trustgraphs.output.nostr-member.v1')
  ),
  'erc8004-agent-v1': keccak256(
    stringToHex('trustgraphs.output.erc8004-agent.v1')
  ),
} as const satisfies Record<string, Hex>

export type ScoreProgramName = keyof typeof SCORE_PROGRAM_IDS
export type ScoreOutputDomainName = keyof typeof SCORE_OUTPUT_DOMAIN_IDS
export type ScoreKeyEncoding = 'eip155-address' | 'bytes32'
export type ScoreIngestion =
  | 'address-merkle'
  | 'contributions'
  | 'hypercerts'
  | 'composition'
  | 'nostr-workspace'
  | 'not-enabled'
export type ScoreApi =
  | 'merkle'
  | 'contributions'
  | 'hypercerts'
  | 'compositions'
  | 'agent-reputation'
  | 'nostr-workspace'
export type ScoreProgramSourceKind =
  | 'instance-registered'
  | 'instance-updated'
  | 'instance-params-hash-updated'

export type ScoreProgramProvenance = {
  programId: Hex
  programName: ScoreProgramName
  outputDomain: Hex
  outputDomainName: ScoreOutputDomainName
  keyEncoding: ScoreKeyEncoding
  instanceId: Hex
  verifier: Hex
  registryOrAccumulator: Hex
  paramsHash: Hex
  source: {
    kind: ScoreProgramSourceKind
    registry: Hex
    blockNumber: string
    logIndex: number
    transactionHash: Hex
  }
}

export type ScoreProgramDefinition = {
  name: ScoreProgramName
  programId: Hex
  outputDomainName: ScoreOutputDomainName
  outputDomain: Hex
  keyEncoding: ScoreKeyEncoding
  ingestion: ScoreIngestion
  tables: readonly string[]
  apis: readonly ScoreApi[]
}

export type ScoreKeyDomainDefinition = {
  name: ScoreOutputDomainName
  id: Hex
  keyEncoding: ScoreKeyEncoding
  tables: readonly string[]
  apis: readonly ScoreApi[]
}

export type ScoreKeyDomainProvenance = Pick<
  ScoreKeyDomainDefinition,
  'name' | 'id' | 'keyEncoding'
>

/** Secondary API key domains live here too (for example Contributions claim UIDs). */
export const SCORE_KEY_DOMAINS: readonly ScoreKeyDomainDefinition[] = [
  {
    name: 'trust-graph-account-v1',
    id: SCORE_OUTPUT_DOMAIN_IDS['trust-graph-account-v1'],
    keyEncoding: 'eip155-address',
    tables: ['offchain.merkle_entry'],
    apis: ['merkle'],
  },
  {
    name: 'weighted-trust-graph-account-v1',
    id: SCORE_OUTPUT_DOMAIN_IDS['weighted-trust-graph-account-v1'],
    keyEncoding: 'eip155-address',
    tables: ['offchain.merkle_entry'],
    apis: ['merkle'],
  },
  {
    name: 'contributions-recipient-v1',
    id: SCORE_OUTPUT_DOMAIN_IDS['contributions-recipient-v1'],
    keyEncoding: 'eip155-address',
    tables: ['offchain.merkle_entry'],
    apis: ['merkle', 'contributions'],
  },
  {
    name: 'contributions-claim-v1',
    id: SCORE_OUTPUT_DOMAIN_IDS['contributions-claim-v1'],
    keyEncoding: 'bytes32',
    tables: [
      'offchain.contribution_score',
      'offchain.contribution_valuation_audit',
    ],
    apis: ['contributions'],
  },
  {
    name: 'hypercerts-node-v1',
    id: SCORE_OUTPUT_DOMAIN_IDS['hypercerts-node-v1'],
    keyEncoding: 'bytes32',
    tables: ['offchain.hypercerts_score'],
    apis: ['hypercerts'],
  },
  {
    name: 'trust-compose-account-v1',
    id: SCORE_OUTPUT_DOMAIN_IDS['trust-compose-account-v1'],
    keyEncoding: 'eip155-address',
    tables: ['offchain.merkle_entry', 'offchain.composition_attribution'],
    apis: ['merkle', 'compositions'],
  },
  {
    name: 'nostr-member-v1',
    id: SCORE_OUTPUT_DOMAIN_IDS['nostr-member-v1'],
    keyEncoding: 'bytes32',
    tables: [
      'offchain.nostr_workspace_metadata',
      'offchain.nostr_workspace_score',
    ],
    apis: ['nostr-workspace'],
  },
  {
    name: 'erc8004-agent-v1',
    id: SCORE_OUTPUT_DOMAIN_IDS['erc8004-agent-v1'],
    keyEncoding: 'bytes32',
    tables: [],
    apis: ['agent-reputation'],
  },
] as const

export const requireScoreKeyDomain = (
  outputDomain: string,
  api: ScoreApi
): ScoreKeyDomainDefinition => {
  const domain = SCORE_KEY_DOMAINS.find(
    (candidate) => candidate.id.toLowerCase() === outputDomain.toLowerCase()
  )
  if (!domain) throw new Error(`unknown score output domain ${outputDomain}`)
  if (!domain.apis.includes(api)) {
    throw new Error(`${domain.name} is not served by the ${api} API`)
  }
  return domain
}

/** Runtime guard for secondary key domains such as Contributions claim UIDs. */
export const parseScoreKeyDomainProvenance = (
  value: unknown,
  api: ScoreApi,
  expected?: ScoreOutputDomainName
): ScoreKeyDomainProvenance => {
  if (!value || typeof value !== 'object') {
    throw new Error('score response is missing its semantic key domain')
  }
  const candidate = value as {
    outputDomain?: unknown
    outputDomainName?: unknown
    keyEncoding?: unknown
  }
  if (typeof candidate.outputDomain !== 'string') {
    throw new Error('score response has a malformed semantic key domain')
  }
  const domain = requireScoreKeyDomain(candidate.outputDomain, api)
  if (expected && domain.name !== expected) {
    throw new Error(
      `score key-domain mismatch: expected ${expected}, got ${domain.name}`
    )
  }
  if (
    candidate.outputDomainName !== domain.name ||
    candidate.keyEncoding !== domain.keyEncoding
  ) {
    throw new Error(
      'score response key-domain labels conflict with its identifier'
    )
  }
  return { name: domain.name, id: domain.id, keyEncoding: domain.keyEncoding }
}

const definition = (
  name: ScoreProgramName,
  outputDomainName: ScoreOutputDomainName,
  keyEncoding: ScoreKeyEncoding,
  ingestion: ScoreIngestion,
  tables: readonly string[],
  apis: readonly ScoreApi[]
): ScoreProgramDefinition => ({
  name,
  programId: SCORE_PROGRAM_IDS[name],
  outputDomainName,
  outputDomain: SCORE_OUTPUT_DOMAIN_IDS[outputDomainName],
  keyEncoding,
  ingestion,
  tables,
  apis,
})

/**
 * The only program-to-decoder routing table. Additions require a reviewed program id, output
 * domain, key encoding, storage surface, and API surface in one place.
 */
export const SCORE_PROGRAMS: readonly ScoreProgramDefinition[] = [
  definition(
    'trust-graph',
    'trust-graph-account-v1',
    'eip155-address',
    'address-merkle',
    ['offchain.merkle_metadata', 'offchain.merkle_entry'],
    ['merkle']
  ),
  definition(
    'trust-graph-weighted',
    'weighted-trust-graph-account-v1',
    'eip155-address',
    'address-merkle',
    ['offchain.merkle_metadata', 'offchain.merkle_entry'],
    ['merkle']
  ),
  definition(
    'contributions',
    'contributions-recipient-v1',
    'eip155-address',
    'contributions',
    [
      'offchain.merkle_metadata',
      'offchain.merkle_entry',
      'offchain.contribution_round',
      'offchain.contribution_score',
      'offchain.contribution_valuation_audit',
    ],
    ['merkle', 'contributions']
  ),
  definition(
    'hypercerts',
    'hypercerts-node-v1',
    'bytes32',
    'hypercerts',
    ['offchain.hypercerts_metadata', 'offchain.hypercerts_score'],
    ['hypercerts']
  ),
  definition(
    'trust-compose',
    'trust-compose-account-v1',
    'eip155-address',
    'composition',
    [
      'offchain.merkle_metadata',
      'offchain.merkle_entry',
      'offchain.composition_epoch',
      'offchain.composition_source',
      'offchain.composition_attribution',
    ],
    ['merkle', 'compositions']
  ),
  definition(
    'nostr-workspace',
    'nostr-member-v1',
    'bytes32',
    'nostr-workspace',
    ['offchain.nostr_workspace_metadata', 'offchain.nostr_workspace_score'],
    ['nostr-workspace']
  ),
  // Reserved for issue #62. Recognition is not enablement: ingestion fails until its own decoder,
  // table, API, verifier, and completeness adapter are implemented.
  definition(
    'agent-reputation',
    'erc8004-agent-v1',
    'bytes32',
    'not-enabled',
    [],
    ['agent-reputation']
  ),
] as const

const normalizeHex = (value: string) => value.toLowerCase()

export const scoreProgramById = (
  programId: string
): ScoreProgramDefinition | undefined =>
  SCORE_PROGRAMS.find(
    (candidate) => normalizeHex(candidate.programId) === normalizeHex(programId)
  )

/** Resolve an exact program/output-domain pair. Unknown IDs and mismatches fail closed. */
export const requireScoreProgram = (
  programId: string,
  outputDomain: string
): ScoreProgramDefinition => {
  const candidate = scoreProgramById(programId)
  if (!candidate) throw new Error(`unknown score program ${programId}`)
  if (normalizeHex(candidate.outputDomain) !== normalizeHex(outputDomain)) {
    throw new Error(
      `score program/output domain mismatch: ${candidate.name} requires ${candidate.outputDomain}, got ${outputDomain}`
    )
  }
  return candidate
}

const KEY_PATTERNS: Record<ScoreKeyEncoding, RegExp> = {
  'eip155-address': /^0x[0-9a-f]{40}$/,
  bytes32: /^0x[0-9a-f]{64}$/,
}
const HEX_ADDRESS = /^0x[0-9a-f]{40}$/i
const HEX_BYTES32 = /^0x[0-9a-f]{64}$/i
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/
const SCORE_PROGRAM_SOURCE_KINDS: readonly ScoreProgramSourceKind[] = [
  'instance-registered',
  'instance-updated',
  'instance-params-hash-updated',
]

export const requireScoreProgramSourceKind = (
  value: string
): ScoreProgramSourceKind => {
  if (!SCORE_PROGRAM_SOURCE_KINDS.includes(value as ScoreProgramSourceKind)) {
    throw new Error(`unknown score-program provenance source ${value}`)
  }
  return value as ScoreProgramSourceKind
}

/**
 * Validate canonical score blob syntax against an already authenticated declaration. Key length
 * is validation only; it never selects a program, decoder, table, or API.
 */
export const validateScoreBlob = (
  scores: Record<string, unknown>,
  program: ScoreProgramDefinition
): Record<string, string> => {
  const pattern = KEY_PATTERNS[program.keyEncoding]
  for (const [key, value] of Object.entries(scores)) {
    if (!pattern.test(key)) {
      throw new Error(
        `${program.name} score key ${key} is not canonical ${program.keyEncoding}`
      )
    }
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
      throw new Error(
        `${program.name} score ${key} must be a positive decimal string`
      )
    }
  }
  return scores as Record<string, string>
}

export const requireScoreApi = (
  programId: string,
  outputDomain: string,
  api: ScoreApi
): ScoreProgramDefinition => {
  const program = requireScoreProgram(programId, outputDomain)
  if (!program.apis.includes(api)) {
    throw new Error(`${program.name} scores are not served by the ${api} API`)
  }
  return program
}

/** Runtime guard for indexer responses; TypeScript annotations alone do not authenticate JSON. */
export const parseScoreProgramProvenance = (
  value: unknown,
  expected?: ScoreProgramName
): ScoreProgramProvenance => {
  if (!value || typeof value !== 'object') {
    throw new Error(
      'score response is missing authenticated program provenance'
    )
  }
  const candidate = value as Partial<ScoreProgramProvenance>
  if (
    typeof candidate.programId !== 'string' ||
    typeof candidate.outputDomain !== 'string' ||
    typeof candidate.instanceId !== 'string' ||
    !HEX_BYTES32.test(candidate.instanceId) ||
    typeof candidate.verifier !== 'string' ||
    !HEX_ADDRESS.test(candidate.verifier) ||
    typeof candidate.registryOrAccumulator !== 'string' ||
    !HEX_ADDRESS.test(candidate.registryOrAccumulator) ||
    typeof candidate.paramsHash !== 'string' ||
    !HEX_BYTES32.test(candidate.paramsHash) ||
    !candidate.source ||
    typeof candidate.source !== 'object'
  ) {
    throw new Error('score response has malformed program provenance')
  }
  const definition = requireScoreProgram(
    candidate.programId,
    candidate.outputDomain
  )
  if (expected && definition.name !== expected) {
    throw new Error(
      `score response program mismatch: expected ${expected}, got ${definition.name}`
    )
  }
  if (
    candidate.programName !== definition.name ||
    candidate.outputDomainName !== definition.outputDomainName ||
    candidate.keyEncoding !== definition.keyEncoding
  ) {
    throw new Error(
      'score response provenance labels conflict with its identifiers'
    )
  }
  const source = candidate.source as ScoreProgramProvenance['source']
  if (
    typeof source.kind !== 'string' ||
    typeof source.registry !== 'string' ||
    !HEX_ADDRESS.test(source.registry) ||
    typeof source.blockNumber !== 'string' ||
    !DECIMAL_INTEGER.test(source.blockNumber) ||
    typeof source.logIndex !== 'number' ||
    !Number.isSafeInteger(source.logIndex) ||
    source.logIndex < 0 ||
    typeof source.transactionHash !== 'string' ||
    !HEX_BYTES32.test(source.transactionHash)
  ) {
    throw new Error('score response has malformed registry-event provenance')
  }
  requireScoreProgramSourceKind(source.kind)
  return candidate as ScoreProgramProvenance
}
