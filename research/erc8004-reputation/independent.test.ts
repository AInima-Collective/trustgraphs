import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// This verifier intentionally imports nothing from reference.ts. It is a second implementation
// over the serialized policy/input, so shared fixture drift cannot make both paths pass silently.
const read = (name: string) =>
  JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) as any

const policy = read('policy.json')
const input = read('input.json')
const golden = read('golden.json')

const canonical = (value: any): string => {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value))
    return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`
}

const sha256 = (value: string) =>
  `0x${createHash('sha256').update(value).digest('hex')}`

const ordered = [...input.records].sort((left, right) => {
  for (const key of ['blockNumber', 'transactionIndex', 'logIndex'] as const) {
    const a = BigInt(left[key])
    const b = BigInt(right[key])
    if (a !== b) return a < b ? -1 : 1
  }
  return left.id.localeCompare(right.id)
})

const allocate = (
  pool: bigint,
  entries: Array<{ key: string; weight: bigint }>
) => {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0n)
  const rows = entries.map((entry) => ({
    ...entry,
    amount: (pool * entry.weight) / total,
    remainder: (pool * entry.weight) % total,
  }))
  let left = pool - rows.reduce((sum, row) => sum + row.amount, 0n)
  for (const row of [...rows].sort((a, b) =>
    a.remainder === b.remainder
      ? a.key.localeCompare(b.key)
      : a.remainder > b.remainder
        ? -1
        : 1
  )) {
    if (left === 0n) break
    row.amount++
    left--
  }
  return new Map(rows.map((row) => [row.key, row.amount]))
}

test('independent serializer reproduces the policy and canonical projection hashes', () => {
  assert.equal(sha256(canonical(policy)), golden.policySha256)
  assert.equal(
    sha256(
      canonical({
        projectionVersion: input.projectionVersion,
        source: input.source,
        records: ordered,
      })
    ),
    golden.inputSha256
  )
  assert.equal(
    sha256(canonical(policy.reviewerTrust.reviewers)),
    policy.reviewerTrust.root
  )
  const { resultSha256: _resultSha256, ...withoutHash } = golden
  assert.equal(sha256(canonical(withoutHash)), golden.resultSha256)
})

test('independent filter and pair fold reproduce every inclusion decision', () => {
  const cutoff = BigInt(policy.registry.blockCutoff)
  const targets = new Set(policy.targetUniverse)
  const weights = new Map(
    policy.reviewerTrust.reviewers.map((reviewer: any) => [
      reviewer.agentKey,
      BigInt(reviewer.weightBps),
    ])
  )
  const decisions = new Map<string, any>()
  const pairs = new Map<string, any[]>()
  for (const record of ordered) {
    let reason: string | null = null
    if (
      record.chainId !== policy.registry.chainId ||
      record.reputationRegistry !== policy.registry.reputationRegistry ||
      record.identityRegistry !== policy.registry.identityRegistry
    )
      reason = 'registry_mismatch'
    else if (BigInt(record.blockNumber) > cutoff) reason = 'after_cutoff'
    else if (!targets.has(record.targetAgentKey))
      reason = 'target_not_in_universe'
    else if (record.tag !== policy.feedback.tag) reason = 'tag_mismatch'
    else if (record.unit !== policy.feedback.unit) reason = 'unit_mismatch'
    else if (record.valueDecimals !== policy.feedback.valueDecimals)
      reason = 'decimals_mismatch'
    else if (record.reviewerAttribution === 'unattributed')
      reason = 'reviewer_unattributed'
    else if (record.reviewerAttribution === 'ambiguous')
      reason = 'reviewer_ambiguous'
    else if (!weights.has(record.reviewerAgentKey))
      reason = 'reviewer_not_eligible'
    else if (record.reviewerAgentKey === record.targetAgentKey)
      reason = 'self_feedback'
    else if (
      BigInt(record.value) < BigInt(policy.feedback.minimum) ||
      BigInt(record.value) > BigInt(policy.feedback.maximum)
    )
      reason = 'value_out_of_range'
    else if (record.revokedBlock && BigInt(record.revokedBlock) <= cutoff)
      reason = 'revoked'

    if (reason) decisions.set(record.id, { reason, pairKey: null })
    else {
      const pairKey = `${record.reviewerAgentKey}->${record.targetAgentKey}`
      const list = pairs.get(pairKey) ?? []
      list.push(record)
      pairs.set(pairKey, list)
    }
  }
  for (const [pairKey, records] of pairs) {
    records.forEach((record, index) =>
      decisions.set(record.id, {
        reason: index === records.length - 1 ? null : 'superseded',
        pairKey,
      })
    )
  }
  assert.deepEqual(
    ordered.map((record) => ({
      recordId: record.id,
      included: decisions.get(record.id).reason === null,
      reason: decisions.get(record.id).reason,
      pairKey: decisions.get(record.id).pairKey,
    })),
    golden.decisions
  )
})

test('independent exact arithmetic reproduces direct and propagated ordering', () => {
  const included = golden.decisions
    .filter((decision: any) => decision.included)
    .map((decision: any) =>
      ordered.find((record) => record.id === decision.recordId)
    )
  const reviewerWeights = new Map<string, bigint>(
    policy.reviewerTrust.reviewers.map((reviewer: any) => [
      reviewer.agentKey,
      BigInt(reviewer.weightBps),
    ])
  )
  const direct = policy.targetUniverse.map((targetAgentKey: string) => {
    const records = included.filter(
      (record: any) => record.targetAgentKey === targetAgentKey
    )
    const denominator = records.reduce(
      (sum: bigint, record: any) =>
        sum + reviewerWeights.get(record.reviewerAgentKey)!,
      0n
    )
    const numerator = records.reduce(
      (sum: bigint, record: any) =>
        sum +
        BigInt(record.value) * reviewerWeights.get(record.reviewerAgentKey)!,
      0n
    )
    return {
      targetAgentKey,
      scoreNumerator: denominator ? numerator.toString() : null,
      scoreDenominator: denominator ? denominator.toString() : null,
      scoreMicros: denominator
        ? (
            (numerator * BigInt(policy.arithmetic.scoreScale)) /
            denominator
          ).toString()
        : null,
      observedWeightBps: denominator.toString(),
      reviewerCount: records.length,
      rank: null as number | null,
    }
  })
  direct.sort((a: any, b: any) => {
    if (a.scoreMicros === null)
      return b.scoreMicros === null
        ? a.targetAgentKey.localeCompare(b.targetAgentKey)
        : 1
    if (b.scoreMicros === null) return -1
    return BigInt(a.scoreMicros) === BigInt(b.scoreMicros)
      ? a.targetAgentKey.localeCompare(b.targetAgentKey)
      : BigInt(a.scoreMicros) > BigInt(b.scoreMicros)
        ? -1
        : 1
  })
  direct.forEach((row: any, index: number) => {
    if (row.scoreMicros !== null) row.rank = index + 1
  })
  assert.deepEqual(direct, golden.direct)

  const nodes = [
    ...new Set([...reviewerWeights.keys(), ...policy.targetUniverse]),
  ].sort()
  const prior = [...reviewerWeights].map(([key, weight]) => ({ key, weight }))
  const scale = BigInt(policy.arithmetic.massScale)
  const damp =
    (scale * BigInt(policy.arithmetic.dampingNumerator)) /
    BigInt(policy.arithmetic.dampingDenominator)
  const teleport = allocate(scale - damp, prior)
  let rank = allocate(scale, prior)
  const outgoing = new Map<string, any[]>()
  for (const record of included.filter(
    (item: any) => BigInt(item.value) > 0n
  )) {
    const row = outgoing.get(record.reviewerAgentKey) ?? []
    row.push(record)
    outgoing.set(record.reviewerAgentKey, row)
  }
  for (
    let iteration = 0;
    iteration < policy.arithmetic.iterations;
    iteration++
  ) {
    const next = new Map(nodes.map((node) => [node, teleport.get(node) ?? 0n]))
    const budgets = allocate(
      damp,
      nodes.map((key) => ({ key, weight: rank.get(key) ?? 0n }))
    )
    for (const node of nodes) {
      const budget = budgets.get(node)!
      if (!budget) continue
      const row = outgoing.get(node) ?? []
      const distributed = allocate(
        budget,
        row.length
          ? row.map((record) => ({
              key: record.targetAgentKey,
              weight: BigInt(record.value),
            }))
          : prior
      )
      for (const [key, amount] of distributed)
        next.set(key, (next.get(key) ?? 0n) + amount)
    }
    rank = next
  }
  const ranked = [...rank]
    .sort((a, b) =>
      a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1
    )
    .map(([agentKey, mass], index) => ({
      agentKey,
      mass: mass.toString(),
      rank: index + 1,
    }))
  assert.deepEqual(ranked, golden.propagation.nodes)
})
