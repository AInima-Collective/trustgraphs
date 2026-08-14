import { performance } from 'node:perf_hooks'

import { keccak256, stringToHex, type Hex } from 'viem'

import { fixturePolicy } from './fixture-builder'
import {
  V1_RESEARCH_BOUNDS,
  WEIGHT_SCALE,
  canonicalScoreBlob,
  compose,
  decodeCanonicalScoreBlob,
  hamilton,
  sourceFromBlob,
  type CapturedSource,
  type CompositionPolicy,
} from './reference'

type Distribution = Map<Hex, number>

const address = (value: number) =>
  `0x${value.toString(16).padStart(40, '0')}` as Hex
const word = (value: number) =>
  `0x${value.toString(16).padStart(64, '0')}` as Hex
const compareCanonicalKey = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0

const distribution = (entries: Array<{ account: Hex; value: bigint }>) => {
  const total = Number(entries.reduce((sum, entry) => sum + entry.value, 0n))
  return new Map(
    entries.map((entry) => [entry.account, Number(entry.value) / total])
  )
}

const sourceDistribution = (source: CapturedSource) =>
  distribution(decodeCanonicalScoreBlob(source.blob))

const resultDistribution = (policy: CompositionPolicy) =>
  distribution(compose(policy).output)

/** Alternative candidate: one Hamilton pass over the exact ideal rational account masses. */
const singleStageIdealHamilton = (policy: CompositionPolicy) => {
  const sources = policy.sources.map((source) => ({
    source,
    entries: decodeCanonicalScoreBlob(source.blob),
  }))
  const productOfTotals = sources.reduce(
    (product, item) => product * item.source.totalValue,
    1n
  )
  const denominator = policy.weightScale * productOfTotals
  const numerators = new Map<Hex, bigint>()
  for (const { source, entries } of sources) {
    const otherTotals = productOfTotals / source.totalValue
    for (const entry of entries) {
      numerators.set(
        entry.account,
        (numerators.get(entry.account) ?? 0n) +
          source.weight * entry.value * otherTotals
      )
    }
  }
  return hamilton(
    policy.outputPool,
    denominator,
    [...numerators].map(([account, value]) => ({
      key: account,
      value,
      data: account,
    }))
  ).map(({ data: account, allocation: value }) => ({ account, value }))
}

const unionKeys = (...values: Distribution[]) =>
  [...new Set(values.flatMap((value) => [...value.keys()]))].sort()

const l1 = (left: Distribution, right: Distribution) =>
  unionKeys(left, right).reduce(
    (sum, key) => sum + Math.abs((left.get(key) ?? 0) - (right.get(key) ?? 0)),
    0
  )

const jensenShannon = (left: Distribution, right: Distribution) => {
  const keys = unionKeys(left, right)
  const kl = (side: Distribution) =>
    keys.reduce((sum, key) => {
      const value = side.get(key) ?? 0
      const middle = ((left.get(key) ?? 0) + (right.get(key) ?? 0)) / 2
      return value === 0 ? sum : sum + value * Math.log2(value / middle)
    }, 0)
  return (kl(left) + kl(right)) / 2
}

const pearson = (left: Distribution, right: Distribution) => {
  const keys = unionKeys(left, right)
  const x = keys.map((key) => left.get(key) ?? 0)
  const y = keys.map((key) => right.get(key) ?? 0)
  const meanX = x.reduce((sum, value) => sum + value, 0) / x.length
  const meanY = y.reduce((sum, value) => sum + value, 0) / y.length
  const numerator = x.reduce(
    (sum, value, index) => sum + (value - meanX) * (y[index]! - meanY),
    0
  )
  const denominator = Math.sqrt(
    x.reduce((sum, value) => sum + (value - meanX) ** 2, 0) *
      y.reduce((sum, value) => sum + (value - meanY) ** 2, 0)
  )
  return denominator === 0 ? 0 : numerator / denominator
}

const supportJaccard = (left: Distribution, right: Distribution) => {
  const leftKeys = new Set(left.keys())
  const rightKeys = new Set(right.keys())
  const intersection = [...leftKeys].filter((key) => rightKeys.has(key)).length
  return intersection / new Set([...leftKeys, ...rightKeys]).size
}

const top = (value: Distribution, count = 3) =>
  [...value]
    .sort((left, right) =>
      left[1] === right[1]
        ? compareCanonicalKey(left[0], right[0])
        : right[1] - left[1]
    )
    .slice(0, count)
    .map(([account, share]) => ({ account, share }))

const withBpsWeights = (policy: CompositionPolicy, bps: number[]) => {
  if (bps.reduce((sum, value) => sum + value, 0) !== 10_000) {
    throw new Error('basis-point weights must sum to 10,000')
  }
  return {
    ...policy,
    sources: policy.sources.map((source, index) => ({
      ...source,
      weight: BigInt(bps[index]!) * 100_000_000_000_000n,
    })),
  }
}

const leaveOneOut = (policy: CompositionPolicy, omitted: number) => {
  const kept = policy.sources.filter((_source, index) => index !== omitted)
  const denominator = kept.reduce((sum, source) => sum + source.weight, 0n)
  const weights = hamilton(
    WEIGHT_SCALE,
    denominator,
    kept.map((source) => ({
      key: source.sourceId,
      value: source.weight,
      data: source,
    }))
  )
  return {
    ...policy,
    sources: weights.map(({ data, allocation }) => ({
      ...data,
      weight: allocation,
    })),
  }
}

const compromisedSource = (policy: CompositionPolicy, sourceIndex: number) => {
  const original = policy.sources[sourceIndex]!
  const replacement = sourceFromBlob({
    sourceId: original.sourceId,
    snapshot: original.snapshot,
    familyId: original.familyId,
    programId: original.programId,
    stateIndex: original.stateIndex,
    freezeBlock: original.freezeBlock,
    weight: original.weight,
    maxAgeBlocks: original.maxAgeBlocks,
    blob: canonicalScoreBlob([{ account: address(999), value: 1n }]),
    required: true,
  })
  return {
    ...policy,
    sources: policy.sources.map((source, index) =>
      index === sourceIndex ? replacement : source
    ),
  }
}

const personalizedReputation = ({
  prior,
  referrals,
  damping = 0.85,
  iterations = 200,
}: {
  prior: number[]
  referrals: number[][]
  damping?: number
  iterations?: number
}) => {
  let rank = [...prior]
  for (let iteration = 0; iteration < iterations; iteration++) {
    const next = prior.map((value) => (1 - damping) * value)
    for (let from = 0; from < rank.length; from++) {
      const row = referrals[from]!
      const rowSum = row.reduce((sum, value) => sum + value, 0)
      if (rowSum === 0) {
        for (let to = 0; to < next.length; to++) {
          next[to]! += damping * rank[from]! * prior[to]!
        }
      } else {
        for (let to = 0; to < next.length; to++) {
          next[to]! += damping * rank[from]! * (row[to]! / rowSum)
        }
      }
    }
    rank = next
  }
  return rank
}

const equalWeights = (count: number) => {
  const base = 10_000n / BigInt(count)
  const remainder = 10_000n - base * BigInt(count)
  return Array.from({ length: count }, (_value, index) =>
    Number(base + (BigInt(index) < remainder ? 1n : 0n))
  )
}

const syntheticPolicy = (aggregateEntries: number): CompositionPolicy => {
  const sourceCount = 8
  const counts = Array.from({ length: sourceCount }, () =>
    Math.floor(aggregateEntries / sourceCount)
  )
  for (let index = 0; index < aggregateEntries % sourceCount; index++) {
    counts[index]!++
  }
  const weights = equalWeights(sourceCount)
  const sources = counts.map((count, sourceIndex) => {
    // Half the records overlap across sources; half are source-specific.
    const shared = Math.floor(count / 2)
    const entries = Array.from({ length: count }, (_value, entryIndex) => ({
      account:
        entryIndex < shared
          ? address(entryIndex + 1)
          : address(100_000 + sourceIndex * 10_000 + entryIndex),
      value: BigInt(((entryIndex * 17 + sourceIndex * 31) % 10_000) + 1),
    })).sort((left, right) => compareCanonicalKey(left.account, right.account))
    return sourceFromBlob({
      sourceId: word(sourceIndex + 1),
      snapshot: address(10_000 + sourceIndex),
      familyId: word(sourceIndex + 101),
      programId: fixturePolicy().admittedProgramId,
      stateIndex: 1n,
      freezeBlock: 1_000_000n,
      weight: BigInt(weights[sourceIndex]!) * 100_000_000_000_000n,
      maxAgeBlocks: 1_000n,
      blob: canonicalScoreBlob(entries),
      required: true,
    })
  })
  return {
    ...fixturePolicy(),
    sources,
    outputPool: 1_000_000_000_000_000_000_000_000n,
  }
}

const benchmark = (aggregateEntries: number) => {
  const policy = syntheticPolicy(aggregateEntries)
  compose(policy)
  const samples: number[] = []
  for (let iteration = 0; iteration < 5; iteration++) {
    const started = performance.now()
    compose(policy)
    samples.push(performance.now() - started)
  }
  samples.sort((left, right) => left - right)
  const sourceEntries = policy.sources.reduce(
    (sum, source) => sum + decodeCanonicalScoreBlob(source.blob).length,
    0
  )
  const union = new Set(
    policy.sources.flatMap((source) =>
      decodeCanonicalScoreBlob(source.blob).map((entry) => entry.account)
    )
  ).size
  const blobBytes = policy.sources.reduce(
    (sum, source) => sum + Buffer.byteLength(source.blob),
    0
  )
  return {
    sources: policy.sources.length,
    aggregateEntries: sourceEntries,
    unionAccounts: union,
    aggregateBlobBytes: blobBytes,
    medianNativeMs: samples[Math.floor(samples.length / 2)],
    maxNativeMs: samples.at(-1),
    deterministicLiveBytesFloor:
      blobBytes + sourceEntries * 36 * 2 + union * 36 * 2,
  }
}

const policy = fixturePolicy()
const baseline = resultDistribution(policy)
const sources = policy.sources.map(sourceDistribution)
const labels = ['A', 'B', 'C']
const pairwise = []
for (let left = 0; left < sources.length; left++) {
  for (let right = left + 1; right < sources.length; right++) {
    pairwise.push({
      pair: `${labels[left]}/${labels[right]}`,
      supportJaccard: supportJaccard(sources[left]!, sources[right]!),
      pearsonWithMissingZero: pearson(sources[left]!, sources[right]!),
      jensenShannonBits: jensenShannon(sources[left]!, sources[right]!),
    })
  }
}

const simplex = []
for (let a = 0; a <= 10_000; a += 1_000) {
  for (let b = 0; b <= 10_000 - a; b += 1_000) {
    const c = 10_000 - a - b
    if (a === 0 || b === 0 || c === 0) continue // V1 sources are required and positive.
    const result = resultDistribution(withBpsWeights(policy, [a, b, c]))
    simplex.push({
      weightsBps: [a, b, c],
      top: top(result, 1)[0],
      l1FromEqual: l1(result, baseline),
    })
  }
}

const cartelNoIngress = personalizedReputation({
  prior: [0.34, 0.33, 0.33, 0, 0, 0],
  referrals: [
    [0, 1, 0, 0, 0, 0],
    [0, 0, 1, 0, 0, 0],
    [1, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0],
    [0, 0, 0, 0, 0, 1],
    [0, 0, 0, 1, 0, 0],
  ],
})
const cartelWithIngress = personalizedReputation({
  prior: [0.34, 0.33, 0.33, 0, 0, 0],
  referrals: [
    [0, 0.9, 0, 0.1, 0, 0],
    [0, 0, 1, 0, 0, 0],
    [1, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0],
    [0, 0, 0, 0, 0, 1],
    [0, 0, 0, 1, 0, 0],
  ],
})

const compromised = resultDistribution(compromisedSource(policy, 0))
const compromisedL1 = l1(baseline, compromised)
const sourceACap =
  Number(policy.sources[0]!.weight) / Number(policy.weightScale)
const singleStage = distribution(singleStageIdealHamilton(policy))
const candidatePools = [7n, 13n, 100n, 1_000_000n].map((outputPool) => {
  const candidate = { ...policy, outputPool }
  const sourceAware = resultDistribution(candidate)
  const idealHamilton = distribution(singleStageIdealHamilton(candidate))
  return {
    outputPool: outputPool.toString(),
    l1ShareDifference: l1(sourceAware, idealHamilton),
    maximumAccountPointDifference: Math.max(
      ...unionKeys(sourceAware, idealHamilton).map(
        (account) =>
          Math.abs(
            (sourceAware.get(account) ?? 0) - (idealHamilton.get(account) ?? 0)
          ) * Number(outputPool)
      )
    ),
  }
})

const report = {
  generatedBy: 'research/composition/simulate.ts',
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  fixture: {
    sourcePositiveSupport: sources.map((source) => source.size),
    unionPositiveSupport: unionKeys(...sources).length,
    equalPolicyTop: top(baseline),
    pairwise,
  },
  weightSimplex: {
    gridStepBps: 1_000,
    interiorPolicies: simplex.length,
    distinctTopAccounts: [
      ...new Set(simplex.map((point) => point.top?.account)),
    ],
    maximumL1FromEqual: Math.max(...simplex.map((point) => point.l1FromEqual)),
    points: simplex,
  },
  candidateComparison: {
    sourceAwareHamilton: {
      exactIntegerSourceQuotas: true,
      exactIntegerSourceAttribution: true,
    },
    singleStageIdealHamilton: {
      exactIntegerSourceQuotas: false,
      exactIntegerSourceAttribution: false,
    },
    oneMillionPointPool: {
      l1ShareDifference: l1(baseline, singleStage),
      maximumAccountPointDifference: Math.max(
        ...unionKeys(baseline, singleStage).map(
          (account) =>
            Math.abs(
              (baseline.get(account) ?? 0) - (singleStage.get(account) ?? 0)
            ) * Number(policy.outputPool)
        )
      ),
    },
    testedPools: candidatePools,
    selected: 'two-stage source-aware Hamilton',
    reason:
      'The observed precision delta is point-sized; exact source quotas and attribution make configured influence auditable.',
  },
  leaveOneSourceOut: policy.sources.map((source, index) => {
    const result = resultDistribution(leaveOneOut(policy, index))
    return {
      omitted: labels[index],
      sourceId: source.sourceId,
      l1FromEqual: l1(result, baseline),
      top: top(result),
    }
  }),
  adversarial: {
    compromisedA: {
      configuredWeight: sourceACap,
      observedL1: compromisedL1,
      idealL1UpperBound: 2 * sourceACap,
      withinBound:
        compromisedL1 <= 2 * sourceACap + 2 / Number(policy.outputPool),
    },
    equalPerInstanceCloneAmplification: [1, 7, 10, 100].map((clones) => ({
      aFamilyClones: clones,
      otherFamilies: 2,
      aFamilyEffectiveShare: clones / (clones + 2),
      admittedByV1MaxSources: clones + 2 <= V1_RESEARCH_BOUNDS.maxSources,
    })),
    metaReferralCartel: {
      lineages: ['A', 'B', 'C', 'X', 'Y', 'Z'],
      noTrustedIngressCartelShare: cartelNoIngress
        .slice(3)
        .reduce((sum, value) => sum + value, 0),
      tenPercentReferralIngressCartelShare: cartelWithIngress
        .slice(3)
        .reduce((sum, value) => sum + value, 0),
      conclusion:
        'Personalization blocks disconnected cartels but not a cartel admitted by a trusted referral.',
    },
  },
  scaling: {
    selectedBounds: V1_RESEARCH_BOUNDS,
    measurements: [24, 1_024, 4_096, 8_192].map(benchmark),
    caveat:
      'Native Node timings and deterministic live-byte floors are research measurements, not SP1 cycle or RSS claims.',
  },
  decisionHashes: {
    scopeHash: policy.scopeHash,
    programId: policy.admittedProgramId,
    reportContentHint: keccak256(stringToHex('source-aware-hamilton-v1')),
  },
}

process.stdout.write(
  `${JSON.stringify(report, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`
)
