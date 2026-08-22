import { type ReactNode } from 'react'

import { Card } from '@/components/Card'
import { SectionHeading } from '@/components/SectionHeading'
import experiment from '@/lib/erc8004-reputation-experiment.json'

const agentNumber = (agentKey: string) => agentKey.split(':').at(-1) ?? '?'

const points = (scoreMicros: string | null) =>
  scoreMicros === null
    ? 'Missing'
    : (Number(scoreMicros) / 1_000_000).toFixed(6)

const percentage = (micros: string) =>
  `${(Number(micros) / 10_000).toFixed(2)}%`

const massPercentage = (mass: string) =>
  `${((Number(mass) / Number(experiment.propagation.reduce((sum, row) => sum + BigInt(row.mass), 0n))) * 100).toFixed(2)}%`

const graphPositions: Record<string, { x: number; y: number }> = {
  '1': { x: 80, y: 55 },
  '2': { x: 80, y: 155 },
  '3': { x: 80, y: 255 },
  '4': { x: 730, y: 45 },
  '5': { x: 730, y: 125 },
  '6': { x: 730, y: 205 },
  '7': { x: 730, y: 285 },
  '8': { x: 485, y: 255 },
  '9': { x: 485, y: 95 },
}

const edgeWidth = (value: string) => 1 + (Number(value) / 100) * 3

const clippedLine = (
  from: { x: number; y: number },
  to: { x: number; y: number }
) => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  const unitX = dx / length
  const unitY = dy / length
  return {
    x1: from.x + unitX * 27,
    y1: from.y + unitY * 27,
    x2: to.x - unitX * 30,
    y2: to.y - unitY * 30,
  }
}

export function Erc8004ReputationExperiment() {
  const excluded = Object.entries(experiment.metrics.excludedByReason)

  return (
    <div className="space-y-10">
      <header className="space-y-5 border-b border-border pb-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="tg-label text-warn">Pinned research artifact</p>
            <h1 className="mt-2 max-w-3xl text-3xl text-text">
              ERC-8004 agent reputation experiment
            </h1>
          </div>
          <span className="border border-warn/40 bg-warn-soft px-3 py-2 text-[10px] uppercase tracking-wider text-warn">
            No-go for production or proof
          </span>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-text-muted">
          One reproducible policy comparison over raw ERC-8004 evidence. This
          output is experimental, unproved, policy-specific, and separate from
          proven TrustGraph scores. It is not a universal agent reputation.
        </p>
      </header>

      <section className="space-y-4">
        <SectionHeading>Declared policy and provenance</SectionHeading>
        <div className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          <Fact
            label="Chain / cutoff"
            value={`OP 10 · ${experiment.policy.registry.blockCutoff}`}
          />
          <Fact
            label="Exact policy"
            value={`${experiment.policy.tag} / ${experiment.policy.unit}`}
          />
          <Fact
            label="Decimals"
            value={String(experiment.policy.valueDecimals)}
          />
          <Fact
            label="Reviewer epoch"
            value={experiment.policy.reviewerEpoch}
          />
        </div>
        <Card
          type="outline"
          size="md"
          className="space-y-2 font-mono text-[10px] text-text-subtle"
        >
          <HashLine
            label="Registry"
            value={experiment.policy.registry.reputationRegistry}
          />
          <HashLine
            label="Implementation"
            value={experiment.policy.registry.implementation}
          />
          <HashLine
            label="Reviewer root"
            value={experiment.policy.reviewerRoot}
          />
          <HashLine
            label="Policy SHA-256"
            value={experiment.generatedFrom.policySha256}
          />
          <HashLine
            label="Input SHA-256"
            value={experiment.generatedFrom.inputSha256}
          />
          <HashLine
            label="Result SHA-256"
            value={experiment.generatedFrom.resultSha256}
          />
        </Card>
        <p className="text-xs leading-relaxed text-text-muted">
          {experiment.policy.interpretation}. Reviewer identities come only from
          verified-wallet history before each event. Current wallet and owner
          state are never substituted.
        </p>
      </section>

      <section className="space-y-4">
        <SectionHeading>Coverage before interpretation</SectionHeading>
        <div className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Observed pairs"
            value={`${experiment.metrics.coverage.observedPairs} / ${experiment.metrics.coverage.possiblePairs}`}
            note={percentage(experiment.metrics.coverage.pairCoverageMicros)}
          />
          <Metric
            label="Missing pairs"
            value={String(experiment.metrics.coverage.missingPairs)}
            note="Not zero or negative"
          />
          <Metric
            label="Observed zero"
            value={String(experiment.metrics.coverage.observedZeroPairs)}
            note="Explicit evidence"
          />
          <Metric
            label="Attribution"
            value={percentage(experiment.metrics.attribution.successMicros)}
            note={`${experiment.metrics.attribution.attributed} / ${experiment.metrics.attribution.denominator}`}
          />
        </div>
      </section>

      <section className="space-y-4">
        <SectionHeading>Positive-edge experiment graph</SectionHeading>
        <p className="max-w-3xl text-xs leading-relaxed text-text-muted">
          Arrows are the nine selected reviewer-to-target records; line width
          reflects the exact 0–100 value. The #8 ↔ #9 reciprocal ring reaches
          the top two propagated positions despite only 500 bps of reviewer
          prior each.
        </p>
        <Card type="outline" size="sm" className="overflow-x-auto p-0">
          <svg
            viewBox="0 0 820 340"
            role="img"
            aria-labelledby="experiment-graph-title experiment-graph-description"
            className="min-w-[720px]"
          >
            <title id="experiment-graph-title">
              Selected ERC-8004 reviewer-to-agent feedback graph
            </title>
            <desc id="experiment-graph-description">
              Nine positive feedback edges. Agents eight and nine form a
              reciprocal ring and rank first and second under propagation.
            </desc>
            <defs>
              <marker
                id="experiment-arrow"
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
              >
                <path d="M0,0 L8,4 L0,8 z" className="fill-text-subtle" />
              </marker>
            </defs>
            <text
              x="32"
              y="325"
              className="fill-text-subtle text-[10px] uppercase tracking-wider"
            >
              Eligible reviewers
            </text>
            <text
              x="680"
              y="325"
              className="fill-text-subtle text-[10px] uppercase tracking-wider"
            >
              Declared targets
            </text>
            {experiment.edges.map((edge) => {
              const from = graphPositions[agentNumber(edge.from)]!
              const to = graphPositions[agentNumber(edge.to)]!
              const line = clippedLine(from, to)
              return (
                <line
                  key={edge.recordId}
                  x1={line.x1}
                  y1={line.y1}
                  x2={line.x2}
                  y2={line.y2}
                  className="stroke-text-subtle opacity-60"
                  strokeWidth={edgeWidth(edge.value)}
                  markerEnd="url(#experiment-arrow)"
                >
                  <title>{`${edge.fromLabel} → ${edge.toLabel}: ${edge.value} ${experiment.policy.unit}`}</title>
                </line>
              )
            })}
            {Object.entries(graphPositions).map(([id, position]) => {
              const target = experiment.propagation.find((row) =>
                row.agentKey.endsWith(`:${id}`)
              )
              const reviewer = ['1', '2', '3', '8', '9'].includes(id)
              return (
                <g
                  key={id}
                  transform={`translate(${position.x} ${position.y})`}
                >
                  <circle
                    r={id === '8' || id === '9' ? 25 : 21}
                    className={
                      id === '8' || id === '9'
                        ? 'fill-warn-soft stroke-warn'
                        : 'fill-surface-2 stroke-hairline-strong'
                    }
                    strokeWidth="1.5"
                  />
                  <text
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="fill-text text-xs font-medium"
                  >
                    #{id}
                  </text>
                  <text
                    y="35"
                    textAnchor="middle"
                    className="fill-text-subtle text-[9px]"
                  >
                    {target
                      ? `prop ${target.rank}`
                      : reviewer
                        ? 'reviewer'
                        : 'missing'}
                  </text>
                </g>
              )
            })}
          </svg>
        </Card>
        <div className="overflow-x-auto border border-border">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="border-b border-border bg-surface-2 text-[9px] uppercase tracking-wider text-text-subtle">
              <tr>
                <th className="px-3 py-2 font-normal">From</th>
                <th className="px-3 py-2 font-normal">To</th>
                <th className="px-3 py-2 text-right font-normal">Value</th>
                <th className="px-3 py-2 text-right font-normal">
                  Reviewer prior
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {experiment.edges.map((edge) => (
                <tr key={edge.recordId}>
                  <td className="px-3 py-2 text-text">{edge.fromLabel}</td>
                  <td className="px-3 py-2 text-text">{edge.toLabel}</td>
                  <td className="px-3 py-2 text-right font-mono text-text-muted">
                    {edge.value}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-text-muted">
                    {edge.reviewerWeightBps} bps
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-4">
        <SectionHeading>Candidate outputs disagree</SectionHeading>
        <div className="grid gap-4 lg:grid-cols-2">
          <CandidateCard
            title="Direct weighted aggregate"
            description="Exact reviewer-trust-weighted mean after pair reconciliation. Missing remains missing."
          >
            {experiment.direct.map((target) => (
              <CandidateRow
                key={target.targetAgentKey}
                label={target.label}
                agentKey={target.targetAgentKey}
                rank={target.rank}
                value={points(target.scoreMicros)}
              />
            ))}
          </CandidateCard>
          <CandidateCard
            title="Damped positive-edge propagation"
            description="0.85 damping and 64 fixed-mass iterations. Values are shares of mass landing on declared targets; zero produces no edge."
          >
            {experiment.propagation.map((target) => (
              <CandidateRow
                key={target.agentKey}
                label={target.label}
                agentKey={target.agentKey}
                rank={target.rank}
                value={massPercentage(target.mass)}
              />
            ))}
          </CandidateCard>
        </div>
        <div className="border border-warn/40 bg-warn-soft p-4 text-xs leading-relaxed text-warn">
          The reciprocal #8/#9 ring captures{' '}
          {percentage(experiment.comparison.reciprocalRingTargetShareMicros)} of
          mass landing on declared targets. Agents #4 and #5 lead the direct
          candidate, while #9 and #8 lead propagation. The propagated output is
          therefore rejected for production use.
        </div>
      </section>

      <section className="space-y-4">
        <SectionHeading>Exclusions and sensitivity</SectionHeading>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card type="outline" size="md">
            <p className="text-[10px] uppercase tracking-wider text-text-subtle">
              One reason per excluded record
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              {excluded.map(([reason, count]) => (
                <div key={reason} className="contents">
                  <dt className="font-mono text-text-muted">{reason}</dt>
                  <dd className="text-right text-text">{count}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card type="outline" size="md">
            <p className="text-[10px] uppercase tracking-wider text-text-subtle">
              Leave one reviewer out
            </p>
            <div className="mt-3 space-y-3 text-xs">
              {experiment.sensitivity.map((run) => (
                <div
                  key={run.omittedReviewerAgentKey}
                  className="border-b border-border pb-2 last:border-0 last:pb-0"
                >
                  <p className="text-text">Omit {run.omittedReviewerLabel}</p>
                  <p className="mt-1 text-[10px] text-text-subtle">
                    max direct Δ {points(run.maxDirectScoreDeltaMicros)} · max
                    propagated mass Δ{' '}
                    {`${(Number(run.maxPropagationTargetMassDelta) / 10_000_000_000).toFixed(2)}%`}
                    {run.targetsLosingAllDirectEvidence.length > 0
                      ? ` · loses all evidence for #${run.targetsLosingAllDirectEvidence.map(agentNumber).join(', #')}`
                      : ''}
                  </p>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </section>

      <section className="space-y-4 border-t border-border pt-8">
        <SectionHeading>Bounded recommendation</SectionHeading>
        <p className="max-w-3xl text-sm leading-relaxed text-text-muted">
          {experiment.recommendation.boundedUse}
        </p>
        <ul className="max-w-3xl list-disc space-y-2 pl-5 text-xs leading-relaxed text-text-muted">
          {experiment.recommendation.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        <p className="max-w-3xl text-xs leading-relaxed text-text-subtle">
          Responses remain observations and do not validate or erase feedback.
          Revocations do not delete history. No value on this page changes a
          score, vouch edge, root, proof, or address TrustGraph ranking.
        </p>
      </section>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface p-3">
      <p className="text-[9px] uppercase tracking-wider text-text-subtle">
        {label}
      </p>
      <p className="mt-1 break-all font-mono text-xs text-text">{value}</p>
    </div>
  )
}

function Metric({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note: string
}) {
  return (
    <div className="bg-surface p-4">
      <p className="text-[9px] uppercase tracking-wider text-text-subtle">
        {label}
      </p>
      <p className="mt-2 font-mono text-xl text-text">{value}</p>
      <p className="mt-1 text-[10px] text-text-subtle">{note}</p>
    </div>
  )
}

function HashLine({ label, value }: { label: string; value: string }) {
  return (
    <p className="break-all">
      <span className="text-text-muted">{label}:</span> {value}
    </p>
  )
}

function CandidateCard({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <Card type="outline" size="md">
      <p className="text-sm text-text">{title}</p>
      <p className="mt-1 text-[10px] leading-relaxed text-text-subtle">
        {description}
      </p>
      <div className="mt-4 divide-y divide-border">{children}</div>
    </Card>
  )
}

function CandidateRow({
  label,
  agentKey,
  rank,
  value,
}: {
  label: string
  agentKey: string
  rank: number | null
  value: string
}) {
  return (
    <div className="grid grid-cols-[3rem_1fr_auto] items-center gap-3 py-2 text-xs">
      <span className="font-mono text-text-subtle">
        {rank ? `#${rank}` : '—'}
      </span>
      <span className="min-w-0 text-text">
        <span className="block">{label}</span>
        <span className="block truncate font-mono text-[9px] text-text-subtle">
          {agentKey}
        </span>
      </span>
      <span className="font-mono tabular-nums text-text-muted">{value}</span>
    </div>
  )
}
