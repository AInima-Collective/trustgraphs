import type { Hex } from 'viem'

import {
  COMPOSITION_PROGRAM_ID,
  type CompositionConfig,
  type CompositionPreview,
  V1_COMPOSITION_BOUNDS,
  WEIGHT_SCALE,
  canonicalCompositionBlob,
} from './core'
import { ZERO_ADDRESS, ZERO_HASH } from '../pagerank/words'

export const COMPOSITION_TRUTH_COPY = {
  title: 'Proved final-distribution blend',
  rawScale:
    "A source's raw point total does not buy influence. Each complete distribution is normalized into its governed quota.",
  weights:
    'Weights are governance choices. The proof enforces them exactly; it does not establish that they are wise, fair, or objective.',
  prior:
    'This is a separate trust-compose program over complete proved allocations. It does not seed another scoring program.',
  noFallback:
    'Every configured source is required. If any exact source state or blob is unavailable, capture stops; there is no substitute, redistribution, or last-known-good fallback.',
} as const

export type CompositionPreflightCode =
  | 'raw-point-scale'
  | 'governed-weights'
  | 'no-fallback'
  | 'source-count'
  | 'wrong-chain'
  | 'wrong-program'
  | 'composition-source'
  | 'missing-control-provenance'
  | 'unavailable-source'
  | 'stale-source'
  | 'zero-weight'
  | 'weight-total'
  | 'zero-quota'
  | 'entry-cap'
  | 'union-cap'
  | 'blob-cap'
  | 'same-family'
  | 'clone-correlation'
  | 'missing-account'
  | 'sparse-support'
  | 'adapter-required'
  | 'quote-unavailable'
  | 'quote-ineligible'
  | 'cadence'
  | 'preview-error'

export type CompositionPreflightIssue = {
  code: CompositionPreflightCode
  level: 'info' | 'warning' | 'error'
  title: string
  detail: string
  action: string
  blocks: boolean
}

export type CompositionQuote = {
  available: boolean
  kind: 'conservative-band' | 'checkpoint'
  feeUsd: bigint | null
  gasUsd: bigint | null
  payableUsd: bigint | null
  eligible: boolean | null
  reason: string | null
  cadence: string
}

const issue = (
  value: Omit<CompositionPreflightIssue, 'blocks'> & {
    blocks?: boolean
  }
): CompositionPreflightIssue => ({
  ...value,
  blocks: value.blocks ?? value.level === 'error',
})

const sameHex = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase()

const controlMissing = (value: Hex) =>
  value === ZERO_HASH || value === ZERO_ADDRESS

export const compositionPreflight = ({
  config,
  preview,
  previewError,
  quote,
  stage,
}: {
  config: CompositionConfig
  preview: CompositionPreview | null
  previewError?: string | null
  quote?: CompositionQuote | null
  stage: 'preview' | 'sign'
}) => {
  const issues: CompositionPreflightIssue[] = [
    issue({
      code: 'raw-point-scale',
      level: 'info',
      title: 'Raw source points normalize away',
      detail: COMPOSITION_TRUTH_COPY.rawScale,
      action: 'Compare quotas and normalized attribution, not source totals.',
      blocks: false,
    }),
    issue({
      code: 'governed-weights',
      level: 'info',
      title: 'Configured weights are policy',
      detail: COMPOSITION_TRUTH_COPY.weights,
      action:
        'Review the simplex and leave-one-out sensitivity before signing.',
      blocks: false,
    }),
    issue({
      code: 'no-fallback',
      level: 'info',
      title: 'Required means fail closed',
      detail: COMPOSITION_TRUTH_COPY.noFallback,
      action: 'Restore the exact source or rotate policy through the timelock.',
      blocks: false,
    }),
  ]

  if (config.sources.length < 2 || config.sources.length > 8) {
    issues.push(
      issue({
        code: 'source-count',
        level: 'error',
        title: 'Select 2–8 sources',
        detail: `The current selection has ${config.sources.length}.`,
        action: 'Add or remove compatible sources.',
      })
    )
  }

  let weightSum = 0n
  let aggregateEntries = 0
  let aggregateBytes = 0
  const union = new Set<string>()
  const families = new Map<string, string[]>()
  const controllers = new Map<string, string[]>()
  for (const source of config.sources) {
    weightSum += source.weight
    aggregateEntries += source.entries.length
    aggregateBytes += new TextEncoder().encode(
      canonicalCompositionBlob(source.entries)
    ).byteLength
    source.entries.forEach((entry) => union.add(entry.account.toLowerCase()))

    const family = source.familyId.toLowerCase()
    families.set(family, [...(families.get(family) ?? []), source.name])
    const controller = source.controller.toLowerCase()
    controllers.set(controller, [
      ...(controllers.get(controller) ?? []),
      source.name,
    ])
    if (source.chainId !== config.chainId) {
      issues.push(
        issue({
          code: 'wrong-chain',
          level: 'error',
          title: `${source.name} is on another chain`,
          detail: `Source chain ${source.chainId}; composition chain ${config.chainId}.`,
          action: 'Choose a source registered on the target chain.',
        })
      )
    }
    if (!sameHex(source.programId, config.admittedProgramId)) {
      issues.push(
        issue({
          code: 'wrong-program',
          level: 'error',
          title: `${source.name} has incompatible score semantics`,
          detail:
            'V1 admits one authenticated source program per composition policy; address width alone is not compatibility.',
          action:
            'Choose sources with the same program and allocation output semantics.',
        })
      )
    }
    if (sameHex(source.programId, COMPOSITION_PROGRAM_ID)) {
      issues.push(
        issue({
          code: 'composition-source',
          level: 'error',
          title: 'Nested compositions are not supported',
          detail: `${source.name} is itself a trust-compose output.`,
          action: 'Choose a non-composite allocation source.',
        })
      )
    }
    if (
      controlMissing(source.controller) ||
      controlMissing(source.registry) ||
      controlMissing(source.verifier) ||
      controlMissing(source.paramsHash) ||
      controlMissing(source.deploymentProvenance) ||
      source.acceptedAtBlock === 0n
    ) {
      issues.push(
        issue({
          code: 'missing-control-provenance',
          level: 'error',
          title: `${source.name} lacks complete control provenance`,
          detail:
            'The source needs an authenticated registry row, nonzero parameter controller, verifier, accepted-state record, reviewed deployment packet, and current parameters.',
          action: 'Migrate or repair the source before admitting it.',
        })
      )
    }
    if (!source.available) {
      issues.push(
        issue({
          code: 'unavailable-source',
          level: 'error',
          title: `${source.name} is unavailable`,
          detail:
            source.availabilityError ??
            'The exact current state and canonical bytes could not be recovered.',
          action:
            'Repair publication and reload this exact state; do not substitute another root.',
        })
      )
    }
    if (
      source.freezeBlock > config.captureBlock ||
      config.captureBlock - source.freezeBlock > source.maxAgeBlocks
    ) {
      issues.push(
        issue({
          code: 'stale-source',
          level: 'error',
          title: `${source.name} is stale`,
          detail: `Latest accepted block ${source.freezeBlock}; preview block ${config.captureBlock}; policy age limit ${source.maxAgeBlocks}.`,
          action:
            'Wait for or trigger a fresh proved source state, then rebuild the preview.',
        })
      )
    }
    if (source.weight <= 0n) {
      issues.push(
        issue({
          code: 'zero-weight',
          level: 'error',
          title: `${source.name} has zero weight`,
          detail:
            'Every required source must have an explicit nonzero policy weight.',
          action: 'Enter a positive percentage or remove the source.',
        })
      )
    }
    if (source.entries.length > config.bounds.maxEntriesPerSource) {
      issues.push(
        issue({
          code: 'entry-cap',
          level: 'error',
          title: `${source.name} exceeds the per-source entry cap`,
          detail: `${source.entries.length} entries > ${config.bounds.maxEntriesPerSource}.`,
          action: 'Choose a bounded source; V1 does not truncate inputs.',
        })
      )
    }
    if (stage === 'sign' && !source.adapter) {
      issues.push(
        issue({
          code: 'adapter-required',
          level: 'error',
          title: `${source.name} has no authenticated adapter`,
          detail:
            'Preview can run without an adapter, but creation and rotation require an adapter from the configured append-only factory.',
          action:
            'Use Prepare selected sources below; the app will deploy and attach the reviewed adapter.',
        })
      )
    }
  }

  if (weightSum !== WEIGHT_SCALE) {
    issues.push(
      issue({
        code: 'weight-total',
        level: 'error',
        title: 'Weights must total exactly 100%',
        detail: `Exact scale total is ${weightSum}; required ${WEIGHT_SCALE}.`,
        action:
          'Use equal weights or adjust percentages until the exact total is 100%.',
      })
    )
  }
  if (aggregateEntries > config.bounds.maxAggregateEntries) {
    issues.push(
      issue({
        code: 'entry-cap',
        level: 'error',
        title: 'Aggregate entry cap exceeded',
        detail: `${aggregateEntries} entries > ${config.bounds.maxAggregateEntries}.`,
        action: 'Remove or replace a source; V1 does not sample or truncate.',
      })
    )
  }
  if (union.size > config.bounds.maxUnionAccounts) {
    issues.push(
      issue({
        code: 'union-cap',
        level: 'error',
        title: 'Union-account cap exceeded',
        detail: `${union.size} accounts > ${config.bounds.maxUnionAccounts}.`,
        action: 'Reduce source support before proposing the policy.',
      })
    )
  }
  if (aggregateBytes > config.bounds.maxAggregateBlobBytes) {
    issues.push(
      issue({
        code: 'blob-cap',
        level: 'error',
        title: 'Canonical source-byte cap exceeded',
        detail: `${aggregateBytes} bytes > ${config.bounds.maxAggregateBlobBytes}.`,
        action:
          'Choose smaller complete sources; manifest size is not a proxy for blob work.',
      })
    )
  }

  for (const [familyId, names] of families) {
    if (names.length < 2) continue
    issues.push(
      issue({
        code: 'same-family',
        level: 'warning',
        title: 'Sources share a publisher family',
        detail: `${names.join(', ')} use family ${familyId}. Treating them as independent evidence may overstate diversity.`,
        action: 'Remove one source if that overlap is unintended.',
        blocks: false,
      })
    )
  }
  for (const [controller, names] of controllers) {
    if (names.length < 2 || controller === ZERO_ADDRESS) continue
    issues.push(
      issue({
        code: 'same-family',
        level: 'warning',
        title: 'Sources share a parameter controller',
        detail: `${names.join(', ')} are governed by ${controller}. Distinct family labels do not make their control independent.`,
        action: 'Remove one source if that overlap is unintended.',
        blocks: false,
      })
    )
  }

  if (preview) {
    if (preview.sourceAllocations.some((source) => source.quota === 0n)) {
      issues.push(
        issue({
          code: 'zero-quota',
          level: 'error',
          title: 'A required source rounds to zero quota',
          detail:
            'The configured pool is too small for every nonzero source weight.',
          action:
            'Raise the output pool or remove the source; V1 never silently drops it.',
        })
      )
    }
    if (preview.metrics.accountsInOneSource > 0) {
      issues.push(
        issue({
          code: 'missing-account',
          level: 'info',
          title: 'Some accounts are absent from other sources',
          detail: `${preview.metrics.accountsInOneSource} accounts occur in exactly one complete distribution. Absence contributes zero; it is not imputed.`,
          action: 'Inspect per-account attribution and support coverage.',
          blocks: false,
        })
      )
    }
    if (preview.metrics.supportCoverage < 0.5) {
      issues.push(
        issue({
          code: 'sparse-support',
          level: 'warning',
          title: 'Source support is sparse',
          detail: `Only ${(preview.metrics.supportCoverage * 100).toFixed(1)}% of source/account cells are populated.`,
          action: 'Review whether sparse coverage matches the governed scope.',
          blocks: false,
        })
      )
    }
    for (const pair of preview.metrics.pairwise) {
      if (pair.overlapRatio < 0.8 || pair.correlation < 0.995) continue
      issues.push(
        issue({
          code: 'clone-correlation',
          level: 'warning',
          title: 'Sources are near-clones',
          detail: `Support overlap ${(pair.overlapRatio * 100).toFixed(1)}%; correlation ${pair.correlation.toFixed(4)}. Extra weight may count the same signal twice.`,
          action: 'Remove a clone if the duplicated signal is unintended.',
          blocks: false,
        })
      )
    }
  } else if (previewError) {
    issues.push(
      issue({
        code: previewError.includes('zero quota')
          ? 'zero-quota'
          : 'preview-error',
        level: 'error',
        title: 'Exact preview refused',
        detail: previewError,
        action:
          'Correct the source, commitment, weight, freshness, or cap failure and rebuild.',
      })
    )
  }

  if (quote) {
    if (!quote.available) {
      issues.push(
        issue({
          code: 'quote-unavailable',
          level: 'error',
          title: 'Proving quote is unavailable',
          detail:
            quote.reason ??
            'The configured vault or exact checkpoint quote could not be read.',
          action:
            'Restore quote availability before signing; proving has no unpaid fallback.',
        })
      )
    } else if (quote.eligible === false) {
      issues.push(
        issue({
          code: 'quote-ineligible',
          level: 'error',
          title: 'The next proof is not payable',
          detail:
            quote.reason ??
            'The vault policy, price feed, cap, or balance refused the quote.',
          action:
            'Fund or repair the proving policy before relying on the next epoch.',
        })
      )
    }
    issues.push(
      issue({
        code: 'cadence',
        level: 'info',
        title: 'Proving cadence',
        detail: quote.cadence,
        action:
          'Confirm the epoch schedule and paid cadence match operator expectations.',
      })
    )
  }

  // A malformed caller-supplied bound should remain visible even before the exact core runs.
  for (const [key, maximum] of Object.entries(V1_COMPOSITION_BOUNDS)) {
    if (config.bounds[key as keyof typeof config.bounds] > maximum) {
      issues.push(
        issue({
          code: 'entry-cap',
          level: 'error',
          title: `${key} exceeds the V1 ceiling`,
          detail: `Configured ${config.bounds[key as keyof typeof config.bounds]}; maximum ${maximum}.`,
          action: 'Use the audited V1 cap or a stricter value.',
        })
      )
    }
  }

  return {
    issues,
    blocked: issues.some((item) => item.blocks),
  }
}
