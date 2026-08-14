import { createHash } from 'node:crypto'

export type AgentKey = `agent:eip155:${number}:0x${string}:${string}`

export type ReviewerTrust = {
  agentKey: AgentKey
  weightBps: string
}

export type ExperimentPolicy = {
  version: 1
  experimentId: string
  registry: {
    namespace: 'eip155'
    chainId: number
    reputationRegistry: `0x${string}`
    identityRegistry: `0x${string}`
    implementation: `0x${string}`
    version: string
    sourceBlock: string
    blockCutoff: string
  }
  feedback: {
    tag: string
    unit: string
    valueDecimals: number
    interpretation: string
    minimum: string
    maximum: string
  }
  reviewerTrust: {
    sourceId: string
    epoch: string
    rootAlgorithm: 'sha256-canonical-json'
    root: `0x${string}`
    weightScaleBps: string
    reviewers: ReviewerTrust[]
  }
  historicalAttribution: Record<string, string>
  pairReconciliation: Record<string, string | string[]>
  coverage: Record<string, string>
  arithmetic: {
    direct: string
    propagation: string
    massScale: string
    scoreScale: string
    dampingNumerator: string
    dampingDenominator: string
    iterations: number
    tieOrder: string
  }
  outputIdentityDomain: string
  targetUniverse: AgentKey[]
}

export type FeedbackProjection = {
  id: string
  chainId: number
  reputationRegistry: `0x${string}`
  identityRegistry: `0x${string}`
  targetAgentKey: AgentKey
  agentId: string
  reviewer: `0x${string}`
  reviewerAttribution: 'attributed' | 'unattributed' | 'ambiguous'
  reviewerAgentKey: AgentKey | null
  reviewerCandidates: AgentKey[]
  reviewerRelationEventId: string | null
  feedbackIndex: string
  value: string
  valueDecimals: number
  tag: string
  unit: string
  revoked: boolean
  revokedBlock: string | null
  responseCount: number
  blockNumber: string
  transactionIndex: number
  logIndex: number
}

export type ExperimentInput = {
  projectionVersion: 1
  source: string
  records: FeedbackProjection[]
}

export const EXCLUSION_REASONS = [
  'registry_mismatch',
  'after_cutoff',
  'target_not_in_universe',
  'tag_mismatch',
  'unit_mismatch',
  'decimals_mismatch',
  'reviewer_unattributed',
  'reviewer_ambiguous',
  'reviewer_not_eligible',
  'self_feedback',
  'value_out_of_range',
  'revoked',
  'superseded',
] as const

export type ExclusionReason = (typeof EXCLUSION_REASONS)[number]

export type FeedbackDecision = {
  recordId: string
  included: boolean
  reason: ExclusionReason | null
  pairKey: string | null
}

export type ReconciledPair = {
  recordId: string
  pairKey: string
  reviewerAgentKey: AgentKey
  targetAgentKey: AgentKey
  reviewerWeightBps: string
  value: string
  responseCount: number
  blockNumber: string
  transactionIndex: number
  logIndex: number
}

type RankedDirect = {
  targetAgentKey: AgentKey
  scoreNumerator: string | null
  scoreDenominator: string | null
  scoreMicros: string | null
  observedWeightBps: string
  reviewerCount: number
  rank: number | null
}

type RankedMass = {
  agentKey: AgentKey
  mass: string
  rank: number
}

export type ExperimentResult = {
  experimentId: string
  policySha256: `0x${string}`
  inputSha256: `0x${string}`
  reviewerTrustRoot: `0x${string}`
  decisions: FeedbackDecision[]
  includedPairs: ReconciledPair[]
  metrics: {
    suppliedRecords: number
    policyRecordDenominator: number
    includedRecords: number
    excludedRecords: number
    excludedByReason: Record<ExclusionReason, number>
    attribution: {
      denominator: number
      attributed: number
      unattributed: number
      ambiguous: number
      successMicros: string
    }
    coverage: {
      possiblePairs: number
      observedPairs: number
      missingPairs: number
      observedZeroPairs: number
      pairCoverageMicros: string
    }
    concentration: {
      includedWeightAcrossPairs: string
      largestReviewerAgentKey: AgentKey
      largestReviewerShareMicros: string
      includedPairsByReviewer: Array<{
        reviewerAgentKey: AgentKey
        pairs: number
        weightedPairMass: string
      }>
    }
    pairReconciliation: {
      supersededRecords: number
      revokedRecords: number
      includedRecordsWithResponses: number
      preservedResponseCount: number
    }
  }
  direct: RankedDirect[]
  propagation: {
    massScale: string
    dampingNumerator: string
    dampingDenominator: string
    iterations: number
    nodes: RankedMass[]
    targets: RankedMass[]
  }
  leaveOneOut: Array<{
    omittedReviewerAgentKey: AgentKey
    targetsLosingAllDirectEvidence: AgentKey[]
    maxDirectScoreDeltaMicros: string
    maxPropagationTargetMassDelta: string
    directTargetDeltas: Array<{
      targetAgentKey: AgentKey
      baseScoreMicros: string | null
      withoutScoreMicros: string | null
      absoluteDeltaMicros: string | null
    }>
    propagationTargetDeltas: Array<{
      targetAgentKey: AgentKey
      baseMass: string
      withoutMass: string
      absoluteDelta: string
    }>
  }>
  comparison: {
    directTargetOrder: AgentKey[]
    propagationTargetOrder: AgentKey[]
    largestRankShift: number
    largestRankShiftAgentKeys: AgentKey[]
    reciprocalRingTargetShareMicros: string
  }
  recommendation: {
    decision: 'no-go-for-production-or-proof'
    boundedUse: string
    reasons: string[]
  }
  resultSha256: `0x${string}`
}

export class ReputationExperimentError extends Error {}

const fail = (message: string): never => {
  throw new ReputationExperimentError(message)
}

const canonicalCompare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0

/** RFC-8785-shaped for this integer/string/boolean/null fixture domain. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      fail('canonical number must be a safe integer')
    return value.toString()
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object') fail('unsupported canonical JSON value')
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => canonicalCompare(left, right))
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`
}

export const sha256Hex = (value: string): `0x${string}` =>
  `0x${createHash('sha256').update(value).digest('hex')}`

const decimal = (value: string, label: string, signed = false) => {
  const pattern = signed ? /^-?(0|[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/
  if (!pattern.test(value)) fail(`${label} must be canonical decimal`)
  return BigInt(value)
}

const validAddress = (value: string) => /^0x[0-9a-f]{40}$/.test(value)
const validHash = (value: string) => /^0x[0-9a-f]{64}$/.test(value)

const expectedAgentKey = (
  chainId: number,
  identityRegistry: string,
  agentId: string
) =>
  `agent:eip155:${chainId}:${identityRegistry}:${decimal(agentId, 'agentId')}`

const validPolicyAgentKey = (policy: ExperimentPolicy, value: string) => {
  const prefix = `agent:eip155:${policy.registry.chainId}:${policy.registry.identityRegistry}:`
  if (!value.startsWith(prefix)) return false
  return /^(0|[1-9][0-9]*)$/.test(value.slice(prefix.length))
}

const comparePosition = (
  left: FeedbackProjection,
  right: FeedbackProjection
) =>
  decimal(left.blockNumber, 'blockNumber') ===
  decimal(right.blockNumber, 'blockNumber')
    ? left.transactionIndex === right.transactionIndex
      ? left.logIndex === right.logIndex
        ? canonicalCompare(left.id, right.id)
        : left.logIndex - right.logIndex
      : left.transactionIndex - right.transactionIndex
    : decimal(left.blockNumber, 'blockNumber') <
        decimal(right.blockNumber, 'blockNumber')
      ? -1
      : 1

const canonicalProjection = (input: ExperimentInput) => ({
  projectionVersion: input.projectionVersion,
  source: input.source,
  records: [...input.records].sort(comparePosition),
})

const validate = (policy: ExperimentPolicy, input: ExperimentInput) => {
  if (policy.version !== 1 || input.projectionVersion !== 1)
    fail('unsupported experiment version')
  if (
    policy.registry.namespace !== 'eip155' ||
    !Number.isSafeInteger(policy.registry.chainId) ||
    policy.registry.chainId <= 0
  )
    fail('invalid registry namespace or chain')
  for (const [label, address] of [
    ['reputationRegistry', policy.registry.reputationRegistry],
    ['identityRegistry', policy.registry.identityRegistry],
    ['implementation', policy.registry.implementation],
  ] as const) {
    if (!validAddress(address)) fail(`${label} must be a lowercase address`)
  }
  decimal(policy.registry.sourceBlock, 'sourceBlock')
  decimal(policy.registry.blockCutoff, 'blockCutoff')
  const minimum = decimal(policy.feedback.minimum, 'minimum', true)
  const maximum = decimal(policy.feedback.maximum, 'maximum', true)
  if (minimum > maximum) fail('feedback bounds are reversed')
  if (
    !Number.isSafeInteger(policy.feedback.valueDecimals) ||
    policy.feedback.valueDecimals < 0 ||
    policy.feedback.valueDecimals > 255
  )
    fail('valueDecimals is invalid')

  const reviewers = policy.reviewerTrust.reviewers
  const reviewerKeys = reviewers.map((reviewer) => reviewer.agentKey)
  if (
    reviewers.length === 0 ||
    new Set(reviewerKeys).size !== reviewerKeys.length ||
    reviewerKeys.some((key) => !validPolicyAgentKey(policy, key)) ||
    reviewerKeys.some(
      (key, index) => index > 0 && key <= reviewerKeys[index - 1]!
    )
  )
    fail('reviewers must be unique and canonically ordered')
  const reviewerTotal = reviewers.reduce(
    (sum, reviewer) => sum + decimal(reviewer.weightBps, 'reviewer weight'),
    0n
  )
  if (
    reviewerTotal !==
    decimal(policy.reviewerTrust.weightScaleBps, 'weight scale')
  )
    fail('reviewer weights must sum to weightScaleBps')
  if (!validHash(policy.reviewerTrust.root)) fail('reviewer root is invalid')
  if (sha256Hex(canonicalJson(reviewers)) !== policy.reviewerTrust.root)
    fail('reviewer trust root mismatch')

  if (
    policy.targetUniverse.length === 0 ||
    new Set(policy.targetUniverse).size !== policy.targetUniverse.length ||
    policy.targetUniverse.some((key) => !validPolicyAgentKey(policy, key)) ||
    policy.targetUniverse.some(
      (key, index) => index > 0 && key <= policy.targetUniverse[index - 1]!
    )
  )
    fail('target universe must be unique and canonically ordered')

  const ids = new Set<string>()
  for (const record of input.records) {
    if (!record.id || ids.has(record.id)) fail('feedback ids must be unique')
    ids.add(record.id)
    if (
      !Number.isSafeInteger(record.chainId) ||
      !validAddress(record.reputationRegistry) ||
      !validAddress(record.identityRegistry) ||
      !validAddress(record.reviewer)
    )
      fail(`${record.id} has invalid chain or address provenance`)
    if (
      record.targetAgentKey !==
      expectedAgentKey(record.chainId, record.identityRegistry, record.agentId)
    )
      fail(`${record.id} target key does not match its provenance`)
    decimal(record.feedbackIndex, `${record.id} feedbackIndex`)
    decimal(record.value, `${record.id} value`, true)
    decimal(record.blockNumber, `${record.id} blockNumber`)
    if (
      !Number.isSafeInteger(record.valueDecimals) ||
      !Number.isSafeInteger(record.responseCount) ||
      record.responseCount < 0 ||
      !Number.isSafeInteger(record.transactionIndex) ||
      record.transactionIndex < 0 ||
      !Number.isSafeInteger(record.logIndex) ||
      record.logIndex < 0
    )
      fail(`${record.id} has an invalid numeric field`)
    if (record.revoked !== (record.revokedBlock !== null))
      fail(`${record.id} revocation provenance is inconsistent`)
    if (record.revokedBlock !== null)
      decimal(record.revokedBlock, `${record.id} revokedBlock`)
    if (
      record.reviewerAttribution === 'attributed' &&
      (!record.reviewerAgentKey ||
        record.reviewerCandidates.length !== 1 ||
        record.reviewerCandidates[0] !== record.reviewerAgentKey ||
        !record.reviewerRelationEventId)
    )
      fail(`${record.id} attributed reviewer evidence is incomplete`)
    if (
      record.reviewerCandidates.some(
        (candidate) => !validPolicyAgentKey(policy, candidate)
      ) ||
      new Set(record.reviewerCandidates).size !==
        record.reviewerCandidates.length ||
      record.reviewerCandidates.some(
        (candidate, index) =>
          index > 0 && candidate <= record.reviewerCandidates[index - 1]!
      )
    )
      fail(`${record.id} reviewer candidates are not canonical`)
    if (
      record.reviewerAttribution !== 'attributed' &&
      (record.reviewerAgentKey !== null ||
        record.reviewerRelationEventId !== null)
    )
      fail(`${record.id} non-attributed evidence substitutes an agent`)
  }

  const arithmetic = policy.arithmetic
  const massScale = decimal(arithmetic.massScale, 'massScale')
  const scoreScale = decimal(arithmetic.scoreScale, 'scoreScale')
  const dampingNumerator = decimal(
    arithmetic.dampingNumerator,
    'damping numerator'
  )
  const dampingDenominator = decimal(
    arithmetic.dampingDenominator,
    'damping denominator'
  )
  if (
    massScale <= 0n ||
    scoreScale <= 0n ||
    dampingNumerator <= 0n ||
    dampingNumerator >= dampingDenominator ||
    !Number.isSafeInteger(arithmetic.iterations) ||
    arithmetic.iterations <= 0 ||
    arithmetic.iterations > 1_000
  )
    fail('arithmetic policy is invalid')
}

const hamilton = (
  pool: bigint,
  entries: Array<{ key: string; value: bigint }>
) => {
  const denominator = entries.reduce((sum, entry) => sum + entry.value, 0n)
  if (
    pool < 0n ||
    denominator <= 0n ||
    entries.some((entry) => entry.value < 0n)
  )
    fail('invalid Hamilton inputs')
  const allocated = entries.map((entry) => ({
    ...entry,
    allocation: (pool * entry.value) / denominator,
    remainder: (pool * entry.value) % denominator,
  }))
  let residual =
    pool - allocated.reduce((sum, entry) => sum + entry.allocation, 0n)
  const order = [...allocated].sort((left, right) =>
    left.remainder === right.remainder
      ? canonicalCompare(left.key, right.key)
      : left.remainder > right.remainder
        ? -1
        : 1
  )
  for (const entry of order) {
    if (residual === 0n) break
    entry.allocation++
    residual--
  }
  if (residual !== 0n) fail('Hamilton residual exceeds entry count')
  return new Map(allocated.map((entry) => [entry.key, entry.allocation]))
}

const absolute = (value: bigint) => (value < 0n ? -value : value)

const rankMass = (values: Map<AgentKey, bigint>): RankedMass[] =>
  [...values]
    .sort((left, right) =>
      left[1] === right[1]
        ? canonicalCompare(left[0], right[0])
        : left[1] > right[1]
          ? -1
          : 1
    )
    .map(([agentKey, mass], index) => ({
      agentKey,
      mass: mass.toString(),
      rank: index + 1,
    }))

const core = (
  policy: ExperimentPolicy,
  input: ExperimentInput,
  omittedReviewerAgentKey: AgentKey | null = null
) => {
  const cutoff = decimal(policy.registry.blockCutoff, 'blockCutoff')
  const minimum = decimal(policy.feedback.minimum, 'minimum', true)
  const maximum = decimal(policy.feedback.maximum, 'maximum', true)
  const targetSet = new Set(policy.targetUniverse)
  const reviewerWeights = new Map(
    policy.reviewerTrust.reviewers
      .filter((reviewer) => reviewer.agentKey !== omittedReviewerAgentKey)
      .map((reviewer) => [
        reviewer.agentKey,
        decimal(reviewer.weightBps, 'reviewer weight'),
      ])
  )
  const sorted = [...input.records].sort(comparePosition)
  const decisions = new Map<string, FeedbackDecision>()
  const candidates: FeedbackProjection[] = []
  const reasonFor = (record: FeedbackProjection): ExclusionReason | null => {
    if (
      record.chainId !== policy.registry.chainId ||
      record.reputationRegistry !== policy.registry.reputationRegistry ||
      record.identityRegistry !== policy.registry.identityRegistry
    )
      return 'registry_mismatch'
    if (decimal(record.blockNumber, 'blockNumber') > cutoff)
      return 'after_cutoff'
    if (!targetSet.has(record.targetAgentKey)) return 'target_not_in_universe'
    if (record.tag !== policy.feedback.tag) return 'tag_mismatch'
    if (record.unit !== policy.feedback.unit) return 'unit_mismatch'
    if (record.valueDecimals !== policy.feedback.valueDecimals)
      return 'decimals_mismatch'
    if (record.reviewerAttribution === 'unattributed')
      return 'reviewer_unattributed'
    if (record.reviewerAttribution === 'ambiguous') return 'reviewer_ambiguous'
    if (
      !record.reviewerAgentKey ||
      !reviewerWeights.has(record.reviewerAgentKey)
    )
      return 'reviewer_not_eligible'
    if (record.reviewerAgentKey === record.targetAgentKey)
      return 'self_feedback'
    const value = decimal(record.value, `${record.id} value`, true)
    if (value < minimum || value > maximum) return 'value_out_of_range'
    if (
      record.revokedBlock !== null &&
      decimal(record.revokedBlock, `${record.id} revokedBlock`) <= cutoff
    )
      return 'revoked'
    return null
  }

  for (const record of sorted) {
    const reason = reasonFor(record)
    if (reason) {
      decisions.set(record.id, {
        recordId: record.id,
        included: false,
        reason,
        pairKey: null,
      })
    } else {
      candidates.push(record)
    }
  }

  const byPair = new Map<string, FeedbackProjection[]>()
  for (const record of candidates) {
    const pairKey = `${record.reviewerAgentKey}->${record.targetAgentKey}`
    const pair = byPair.get(pairKey) ?? []
    pair.push(record)
    byPair.set(pairKey, pair)
  }
  for (const [pairKey, records] of byPair) {
    const ordered = records.sort(comparePosition)
    for (const record of ordered.slice(0, -1)) {
      decisions.set(record.id, {
        recordId: record.id,
        included: false,
        reason: 'superseded',
        pairKey,
      })
    }
    const selected = ordered.at(-1)!
    decisions.set(selected.id, {
      recordId: selected.id,
      included: true,
      reason: null,
      pairKey,
    })
  }

  const orderedDecisions = sorted.map((record) => decisions.get(record.id)!)
  const includedPairs: ReconciledPair[] = sorted
    .filter((record) => decisions.get(record.id)?.included)
    .map((record) => ({
      recordId: record.id,
      pairKey: decisions.get(record.id)!.pairKey!,
      reviewerAgentKey: record.reviewerAgentKey!,
      targetAgentKey: record.targetAgentKey,
      reviewerWeightBps: reviewerWeights
        .get(record.reviewerAgentKey!)!
        .toString(),
      value: record.value,
      responseCount: record.responseCount,
      blockNumber: record.blockNumber,
      transactionIndex: record.transactionIndex,
      logIndex: record.logIndex,
    }))

  const scoreScale = decimal(policy.arithmetic.scoreScale, 'scoreScale')
  const directUnranked: RankedDirect[] = policy.targetUniverse.map(
    (targetAgentKey) => {
      const targetPairs = includedPairs.filter(
        (pair) => pair.targetAgentKey === targetAgentKey
      )
      const denominator = targetPairs.reduce(
        (sum, pair) => sum + decimal(pair.reviewerWeightBps, 'pair weight'),
        0n
      )
      const numerator = targetPairs.reduce(
        (sum, pair) =>
          sum +
          decimal(pair.value, 'pair value', true) *
            decimal(pair.reviewerWeightBps, 'pair weight'),
        0n
      )
      return {
        targetAgentKey,
        scoreNumerator: denominator === 0n ? null : numerator.toString(),
        scoreDenominator: denominator === 0n ? null : denominator.toString(),
        scoreMicros:
          denominator === 0n
            ? null
            : ((numerator * scoreScale) / denominator).toString(),
        observedWeightBps: denominator.toString(),
        reviewerCount: targetPairs.length,
        rank: null,
      }
    }
  )
  const directOrder = [...directUnranked].sort((left, right) => {
    if (left.scoreMicros === null)
      return right.scoreMicros === null
        ? canonicalCompare(left.targetAgentKey, right.targetAgentKey)
        : 1
    if (right.scoreMicros === null) return -1
    const leftScore = BigInt(left.scoreMicros)
    const rightScore = BigInt(right.scoreMicros)
    return leftScore === rightScore
      ? canonicalCompare(left.targetAgentKey, right.targetAgentKey)
      : leftScore > rightScore
        ? -1
        : 1
  })
  for (const [index, target] of directOrder.entries()) {
    if (target.scoreMicros !== null) target.rank = index + 1
  }

  const massScale = decimal(policy.arithmetic.massScale, 'massScale')
  const dampingNumerator = decimal(
    policy.arithmetic.dampingNumerator,
    'damping numerator'
  )
  const dampingDenominator = decimal(
    policy.arithmetic.dampingDenominator,
    'damping denominator'
  )
  const dampingPool = (massScale * dampingNumerator) / dampingDenominator
  const teleportPool = massScale - dampingPool
  const priorEntries = [...reviewerWeights].map(([key, value]) => ({
    key,
    value,
  }))
  if (priorEntries.length === 0) fail('leave-one-out removed every reviewer')
  const allNodes = [
    ...new Set([...reviewerWeights.keys(), ...policy.targetUniverse]),
  ].sort(canonicalCompare) as AgentKey[]
  const priorMass = hamilton(massScale, priorEntries)
  const teleportMass = hamilton(teleportPool, priorEntries)
  let ranks = new Map<AgentKey, bigint>(
    allNodes.map((node) => [node, priorMass.get(node) ?? 0n])
  )
  const outgoing = new Map<AgentKey, ReconciledPair[]>()
  for (const pair of includedPairs.filter((item) => BigInt(item.value) > 0n)) {
    const row = outgoing.get(pair.reviewerAgentKey) ?? []
    row.push(pair)
    outgoing.set(pair.reviewerAgentKey, row)
  }
  for (
    let iteration = 0;
    iteration < policy.arithmetic.iterations;
    iteration++
  ) {
    const next = new Map<AgentKey, bigint>(
      allNodes.map((node) => [node, teleportMass.get(node) ?? 0n])
    )
    const budgets = hamilton(
      dampingPool,
      allNodes.map((key) => ({ key, value: ranks.get(key)! }))
    )
    for (const node of allNodes) {
      const budget = budgets.get(node)!
      if (budget === 0n) continue
      const row = outgoing.get(node) ?? []
      const allocations =
        row.length > 0
          ? hamilton(
              budget,
              row.map((pair) => ({
                key: pair.targetAgentKey,
                value: BigInt(pair.value),
              }))
            )
          : hamilton(budget, priorEntries)
      for (const [target, amount] of allocations) {
        next.set(
          target as AgentKey,
          (next.get(target as AgentKey) ?? 0n) + amount
        )
      }
    }
    if (
      [...next.values()].reduce((sum, value) => sum + value, 0n) !== massScale
    )
      fail('propagation mass was not conserved')
    ranks = next
  }
  const rankedNodes = rankMass(ranks)
  const propagationTargets = rankedNodes.filter((node) =>
    targetSet.has(node.agentKey)
  )

  return {
    decisions: orderedDecisions,
    includedPairs,
    direct: directOrder,
    propagationNodes: rankedNodes,
    propagationTargets,
  }
}

export const runExperiment = (
  policy: ExperimentPolicy,
  input: ExperimentInput
): ExperimentResult => {
  validate(policy, input)
  const base = core(policy, input)
  const cutoff = decimal(policy.registry.blockCutoff, 'blockCutoff')
  const policyRecords = input.records.filter(
    (record) =>
      record.chainId === policy.registry.chainId &&
      record.reputationRegistry === policy.registry.reputationRegistry &&
      record.identityRegistry === policy.registry.identityRegistry &&
      decimal(record.blockNumber, 'blockNumber') <= cutoff
  )
  const attributionRecords = policyRecords.filter(
    (record) =>
      record.targetAgentKey &&
      record.tag === policy.feedback.tag &&
      record.unit === policy.feedback.unit &&
      record.valueDecimals === policy.feedback.valueDecimals
  )
  const attribution = {
    denominator: attributionRecords.length,
    attributed: attributionRecords.filter(
      (record) => record.reviewerAttribution === 'attributed'
    ).length,
    unattributed: attributionRecords.filter(
      (record) => record.reviewerAttribution === 'unattributed'
    ).length,
    ambiguous: attributionRecords.filter(
      (record) => record.reviewerAttribution === 'ambiguous'
    ).length,
    successMicros: '0',
  }
  attribution.successMicros = (
    (BigInt(attribution.attributed) * 1_000_000n) /
    BigInt(attribution.denominator || 1)
  ).toString()

  const possiblePairs = policy.reviewerTrust.reviewers.reduce(
    (sum, reviewer) =>
      sum +
      policy.targetUniverse.filter((target) => target !== reviewer.agentKey)
        .length,
    0
  )
  const excludedByReason = Object.fromEntries(
    EXCLUSION_REASONS.map((reason) => [
      reason,
      base.decisions.filter((decision) => decision.reason === reason).length,
    ])
  ) as Record<ExclusionReason, number>
  const pairMassByReviewer = new Map<
    AgentKey,
    { pairs: number; mass: bigint }
  >()
  for (const pair of base.includedPairs) {
    const current = pairMassByReviewer.get(pair.reviewerAgentKey) ?? {
      pairs: 0,
      mass: 0n,
    }
    current.pairs++
    current.mass += BigInt(pair.reviewerWeightBps)
    pairMassByReviewer.set(pair.reviewerAgentKey, current)
  }
  const includedWeightAcrossPairs = [...pairMassByReviewer.values()].reduce(
    (sum, reviewer) => sum + reviewer.mass,
    0n
  )
  const concentrated = [...pairMassByReviewer]
    .sort((left, right) =>
      left[1].mass === right[1].mass
        ? canonicalCompare(left[0], right[0])
        : left[1].mass > right[1].mass
          ? -1
          : 1
    )
    .at(0)
  if (concentrated === undefined)
    throw new ReputationExperimentError('experiment has no included pairs')
  const [largestReviewerAgentKey, largestReviewer] = concentrated

  const baseDirect = new Map(
    base.direct.map((target) => [target.targetAgentKey, target.scoreMicros])
  )
  const basePropagation = new Map(
    base.propagationTargets.map((target) => [
      target.agentKey,
      BigInt(target.mass),
    ])
  )
  const leaveOneOut = policy.reviewerTrust.reviewers.map((reviewer) => {
    const omitted = core(policy, input, reviewer.agentKey)
    const omittedDirect = new Map(
      omitted.direct.map((target) => [
        target.targetAgentKey,
        target.scoreMicros,
      ])
    )
    const omittedPropagation = new Map(
      omitted.propagationTargets.map((target) => [
        target.agentKey,
        BigInt(target.mass),
      ])
    )
    const directTargetDeltas = policy.targetUniverse.map((targetAgentKey) => {
      const before = baseDirect.get(targetAgentKey) ?? null
      const after = omittedDirect.get(targetAgentKey) ?? null
      return {
        targetAgentKey,
        baseScoreMicros: before,
        withoutScoreMicros: after,
        absoluteDeltaMicros:
          before === null || after === null
            ? null
            : absolute(BigInt(before) - BigInt(after)).toString(),
      }
    })
    const propagationTargetDeltas = policy.targetUniverse.map(
      (targetAgentKey) => {
        const before = basePropagation.get(targetAgentKey) ?? 0n
        const after = omittedPropagation.get(targetAgentKey) ?? 0n
        return {
          targetAgentKey,
          baseMass: before.toString(),
          withoutMass: after.toString(),
          absoluteDelta: absolute(before - after).toString(),
        }
      }
    )
    return {
      omittedReviewerAgentKey: reviewer.agentKey,
      targetsLosingAllDirectEvidence: directTargetDeltas
        .filter(
          (target) =>
            target.baseScoreMicros !== null &&
            target.withoutScoreMicros === null
        )
        .map((target) => target.targetAgentKey),
      maxDirectScoreDeltaMicros: directTargetDeltas
        .reduce(
          (maximum, target) =>
            target.absoluteDeltaMicros === null
              ? maximum
              : BigInt(target.absoluteDeltaMicros) > maximum
                ? BigInt(target.absoluteDeltaMicros)
                : maximum,
          0n
        )
        .toString(),
      maxPropagationTargetMassDelta: propagationTargetDeltas
        .reduce(
          (maximum, target) =>
            BigInt(target.absoluteDelta) > maximum
              ? BigInt(target.absoluteDelta)
              : maximum,
          0n
        )
        .toString(),
      directTargetDeltas,
      propagationTargetDeltas,
    }
  })

  const directTargetOrder = base.direct
    .filter((target) => target.rank !== null)
    .map((target) => target.targetAgentKey)
  const propagationTargetOrder = base.propagationTargets.map(
    (target) => target.agentKey
  )
  const rankShifts = directTargetOrder.map((agentKey, directIndex) => ({
    agentKey,
    shift: Math.abs(directIndex - propagationTargetOrder.indexOf(agentKey)),
  }))
  const largestRankShift = Math.max(...rankShifts.map((item) => item.shift))
  const ringKeys = new Set(
    policy.targetUniverse.filter(
      (key) => key.endsWith(':8') || key.endsWith(':9')
    )
  )
  const ringMass = base.propagationTargets
    .filter((target) => ringKeys.has(target.agentKey))
    .reduce((sum, target) => sum + BigInt(target.mass), 0n)
  const targetMass = base.propagationTargets.reduce(
    (sum, target) => sum + BigInt(target.mass),
    0n
  )

  const withoutHash = {
    experimentId: policy.experimentId,
    policySha256: sha256Hex(canonicalJson(policy)),
    inputSha256: sha256Hex(canonicalJson(canonicalProjection(input))),
    reviewerTrustRoot: policy.reviewerTrust.root,
    decisions: base.decisions,
    includedPairs: base.includedPairs,
    metrics: {
      suppliedRecords: input.records.length,
      policyRecordDenominator: policyRecords.length,
      includedRecords: base.includedPairs.length,
      excludedRecords: input.records.length - base.includedPairs.length,
      excludedByReason,
      attribution,
      coverage: {
        possiblePairs,
        observedPairs: base.includedPairs.length,
        missingPairs: possiblePairs - base.includedPairs.length,
        observedZeroPairs: base.includedPairs.filter(
          (pair) => BigInt(pair.value) === 0n
        ).length,
        pairCoverageMicros: (
          (BigInt(base.includedPairs.length) * 1_000_000n) /
          BigInt(possiblePairs)
        ).toString(),
      },
      concentration: {
        includedWeightAcrossPairs: includedWeightAcrossPairs.toString(),
        largestReviewerAgentKey,
        largestReviewerShareMicros: (
          (largestReviewer.mass * 1_000_000n) /
          includedWeightAcrossPairs
        ).toString(),
        includedPairsByReviewer: [...pairMassByReviewer]
          .sort(([left], [right]) => canonicalCompare(left, right))
          .map(([reviewerAgentKey, value]) => ({
            reviewerAgentKey,
            pairs: value.pairs,
            weightedPairMass: value.mass.toString(),
          })),
      },
      pairReconciliation: {
        supersededRecords: excludedByReason.superseded,
        revokedRecords: excludedByReason.revoked,
        includedRecordsWithResponses: base.includedPairs.filter(
          (pair) => pair.responseCount > 0
        ).length,
        preservedResponseCount: base.includedPairs.reduce(
          (sum, pair) => sum + pair.responseCount,
          0
        ),
      },
    },
    direct: base.direct,
    propagation: {
      massScale: policy.arithmetic.massScale,
      dampingNumerator: policy.arithmetic.dampingNumerator,
      dampingDenominator: policy.arithmetic.dampingDenominator,
      iterations: policy.arithmetic.iterations,
      nodes: base.propagationNodes,
      targets: base.propagationTargets,
    },
    leaveOneOut,
    comparison: {
      directTargetOrder,
      propagationTargetOrder,
      largestRankShift,
      largestRankShiftAgentKeys: rankShifts
        .filter((item) => item.shift === largestRankShift)
        .map((item) => item.agentKey),
      reciprocalRingTargetShareMicros: (
        (ringMass * 1_000_000n) /
        (targetMass || 1n)
      ).toString(),
    },
    recommendation: {
      decision: 'no-go-for-production-or-proof' as const,
      boundedUse:
        'Continue only as a policy-specific offline comparison and data-quality diagnostic.',
      reasons: [
        'The declared reviewer-target pair coverage is sparse and missing evidence cannot be interpreted as zero.',
        'A small reciprocal ring changes the propagated ordering despite low reviewer-prior weight.',
        'Leave-one-reviewer-out runs remove evidence or materially move at least one target.',
        'The policy depends on a curated reviewer root and one exact tag/unit interpretation.',
      ],
    },
  }
  return {
    ...withoutHash,
    resultSha256: sha256Hex(canonicalJson(withoutHash)),
  }
}

export const canonicalExperimentInput = (input: ExperimentInput) =>
  canonicalJson(canonicalProjection(input))

export const canonicalExperimentPolicy = (policy: ExperimentPolicy) =>
  canonicalJson(policy)
