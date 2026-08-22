import {
  type Address,
  type Hex,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  stringToHex,
} from 'viem'

export const REFERRAL_BUDGET = 1_000_000_000_000_000_000n
export const ENDORSEMENT_KINDS = [
  'integrity',
  'methodology',
  'referral',
  'agreement',
  'warning',
] as const
export type EndorsementKind = (typeof ENDORSEMENT_KINDS)[number]
export const ENDORSEMENT_STATUSES = [
  'unknown',
  'active',
  'wrong-scope',
  'wrong-subject-configuration',
  'revoked',
  'superseded',
  'not-started',
  'expired',
  'issuer-configuration-rotated',
  'subject-configuration-rotated',
] as const
export type EndorsementStatus = (typeof ENDORSEMENT_STATUSES)[number]

export const LINEAGE_DOMAIN = keccak256(
  stringToHex('trustgraphs.graph-lineage.v1')
)
export const CONFIGURATION_DOMAIN = keccak256(
  stringToHex('trustgraphs.graph-configuration.v1')
)
export const EPOCH_DOMAIN = keccak256(stringToHex('trustgraphs.graph-epoch.v1'))
export const ENDORSEMENT_DOMAIN = keccak256(
  stringToHex('trustgraphs.graph-endorsement.v1')
)

export const graphLineageId = (
  chainId: bigint,
  instanceRegistry: Address,
  instanceId: Hex
) =>
  keccak256(
    encodeAbiParameters(parseAbiParameters('bytes32,uint256,address,bytes32'), [
      LINEAGE_DOMAIN,
      chainId,
      instanceRegistry,
      instanceId,
    ])
  )

export type ConfigurationIdentity = {
  lineageId: Hex
  version: bigint
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
}

export const graphConfigurationId = (config: ConfigurationIdentity) =>
  keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        'bytes32,bytes32,uint64,bytes32,address,address,address,bytes32,address,address,bytes32,bytes32,bytes32,bytes32,bytes32'
      ),
      [
        CONFIGURATION_DOMAIN,
        config.lineageId,
        config.version,
        config.programId,
        config.snapshot,
        config.verifier,
        config.registryOrAccumulator,
        config.paramsHash,
        config.controller,
        config.authority,
        config.familyId,
        config.methodId,
        config.scopeHash,
        config.identityDomain,
        config.sourceLineagePolicyHash,
      ]
    )
  )

export type EpochIdentity = {
  lineageId: Hex
  configurationId: Hex
  checkpointId: bigint
  freezeBlock: bigint
  root: Hex
  blobSha256: Hex
  cidDigest: Hex
  totalValue: bigint
  acceptedAtBlock: bigint
  programVKey: Hex
}

export const graphEpochId = (epoch: EpochIdentity) =>
  keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        'bytes32,bytes32,bytes32,uint256,uint256,bytes32,bytes32,bytes32,uint256,uint256,bytes32'
      ),
      [
        EPOCH_DOMAIN,
        epoch.lineageId,
        epoch.configurationId,
        epoch.checkpointId,
        epoch.freezeBlock,
        epoch.root,
        epoch.blobSha256,
        epoch.cidDigest,
        epoch.totalValue,
        epoch.acceptedAtBlock,
        epoch.programVKey,
      ]
    )
  )

export const graphEndorsementId = (
  chainId: bigint,
  registry: Address,
  issuerLineageId: Hex,
  scopeHash: Hex,
  sequence: bigint
) =>
  keccak256(
    encodeAbiParameters(
      parseAbiParameters('bytes32,uint256,address,bytes32,bytes32,uint64'),
      [
        ENDORSEMENT_DOMAIN,
        chainId,
        registry,
        issuerLineageId,
        scopeHash,
        sequence,
      ]
    )
  )

export type EndorsementRecord = {
  id: Hex
  issuerLineageId: Hex
  subjectLineageId: Hex
  issuerConfigurationId: Hex
  subjectConfigurationId: Hex
  scopeHash: Hex
  kind: number
  weight: string | bigint
  validFrom: string | bigint
  validUntil: string | bigint
  evidenceURI: string
  evidenceDigest: Hex
  evidenceMutable: boolean
  sequence: string | bigint
  supersededBy: Hex | null
  revokedAt: string | bigint | null
}

export type ConfigurationHead = {
  currentConfigurationId: Hex | null
  live: boolean
}

/** Mirrors `GraphLineageRegistry.endorsementStatus` in the exact fail-closed order. */
export const classifyEndorsement = (
  endorsement: EndorsementRecord | null,
  now: bigint,
  issuer: ConfigurationHead,
  subject: ConfigurationHead,
  expectedScope?: Hex,
  expectedSubjectConfigurationId?: Hex
): EndorsementStatus => {
  if (!endorsement) return 'unknown'
  if (expectedScope && endorsement.scopeHash !== expectedScope)
    return 'wrong-scope'
  if (
    expectedSubjectConfigurationId &&
    endorsement.subjectConfigurationId !== expectedSubjectConfigurationId
  )
    return 'wrong-subject-configuration'
  if (endorsement.revokedAt !== null) return 'revoked'
  if (endorsement.supersededBy !== null) return 'superseded'
  if (now < BigInt(endorsement.validFrom)) return 'not-started'
  if (now >= BigInt(endorsement.validUntil)) return 'expired'
  if (
    !issuer.live ||
    issuer.currentConfigurationId !== endorsement.issuerConfigurationId
  )
    return 'issuer-configuration-rotated'
  if (
    !subject.live ||
    subject.currentConfigurationId !== endorsement.subjectConfigurationId
  )
    return 'subject-configuration-rotated'
  return 'active'
}

export type ReferralConfiguration = {
  id: Hex
  familyId: Hex
  methodId: Hex
  controller: Address
  authority: Address
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

/** Build only referral adjacency. Other typed records are returned nowhere in this matrix. */
export const buildReferralAdjacency = (
  endorsements: EndorsementRecord[],
  statuses: Map<Hex, EndorsementStatus | 'verification-unavailable'>,
  configurations: Map<Hex, ReferralConfiguration>
) => {
  const edges: ReferralEdge[] = []
  const spend = new Map<string, bigint>()
  // Preserve a zero-spend row for issuers whose only referrals are expired/revoked/rotated. That
  // makes the full unused 1e18 explicit instead of making the issuer disappear from the budget.
  for (const endorsement of endorsements) {
    if (ENDORSEMENT_KINDS[endorsement.kind] !== 'referral') continue
    const key = `${endorsement.issuerLineageId}:${endorsement.scopeHash}`
    if (!spend.has(key)) spend.set(key, 0n)
  }
  for (const endorsement of endorsements) {
    if (
      ENDORSEMENT_KINDS[endorsement.kind] !== 'referral' ||
      statuses.get(endorsement.id) !== 'active'
    )
      continue
    const issuer = configurations.get(endorsement.issuerConfigurationId)
    const subject = configurations.get(endorsement.subjectConfigurationId)
    if (!issuer || !subject)
      throw new Error('active referral is missing configuration provenance')
    const weight = BigInt(endorsement.weight)
    const key = `${endorsement.issuerLineageId}:${endorsement.scopeHash}`
    const next = (spend.get(key) ?? 0n) + weight
    if (next > REFERRAL_BUDGET)
      throw new Error(`referral budget exceeded for ${key}`)
    spend.set(key, next)
    edges.push({
      endorsementId: endorsement.id,
      issuerLineageId: endorsement.issuerLineageId,
      subjectLineageId: endorsement.subjectLineageId,
      scopeHash: endorsement.scopeHash,
      weight: weight.toString(),
      evidenceURI: endorsement.evidenceURI,
      evidenceDigest: endorsement.evidenceDigest,
      evidenceMutable: endorsement.evidenceMutable,
      overlap: {
        family: issuer.familyId === subject.familyId,
        method: issuer.methodId === subject.methodId,
        controller:
          issuer.controller.toLowerCase() === subject.controller.toLowerCase(),
        authority:
          issuer.authority.toLowerCase() === subject.authority.toLowerCase(),
      },
    })
  }
  const budgets = [...spend.entries()].map(([key, spent]) => {
    const separator = key.indexOf(':')
    return {
      issuerLineageId: key.slice(0, separator) as Hex,
      scopeHash: key.slice(separator + 1) as Hex,
      spent: spent.toString(),
      unused: (REFERRAL_BUDGET - spent).toString(),
    }
  })
  return { edges, budgets }
}

/** Compare the indexed current configuration with the canonical InstanceRegistry tuple. */
export const registryTupleLive = (
  lineage: {
    instanceRegistry: Hex
    instanceId: Hex
    currentConfigurationId: Hex | null
  },
  configuration: {
    id: Hex
    programId: Hex
    snapshot: Hex
    verifier: Hex
    registryOrAccumulator: Hex
    paramsHash: Hex
  },
  binding:
    | {
        sourceRegistry: Hex
        instanceId: Hex
        programId: Hex
        snapshot: Hex
        verifier: Hex
        registryOrAccumulator: Hex
        paramsHash: Hex
        conflict: boolean
      }
    | undefined
) =>
  lineage.currentConfigurationId === configuration.id &&
  binding !== undefined &&
  !binding.conflict &&
  binding.sourceRegistry.toLowerCase() ===
    lineage.instanceRegistry.toLowerCase() &&
  binding.instanceId === lineage.instanceId &&
  binding.programId === configuration.programId &&
  binding.snapshot.toLowerCase() === configuration.snapshot.toLowerCase() &&
  binding.verifier.toLowerCase() === configuration.verifier.toLowerCase() &&
  binding.registryOrAccumulator.toLowerCase() ===
    configuration.registryOrAccumulator.toLowerCase() &&
  binding.paramsHash === configuration.paramsHash
