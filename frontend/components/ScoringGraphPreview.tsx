'use client'

import { useTheme } from 'next-themes'
import { useMemo, useState } from 'react'
import type { Hex } from 'viem'

import { nodeColorForValue, readGraphTokens } from '@/lib/graphTheme'
import type {
  PreviewGraphEdge,
  ScoreMove,
  ScoringPreview,
} from '@/lib/scoring-preview'
import { cn, formatBigNumber } from '@/lib/utils'

import { CopyableText } from './CopyableText'

type PreviewStage = 'current' | 'proposed'
type PreviewMode = PreviewStage | 'compare'
type Point = { x: number; y: number }

const MAX_VISIBLE_NODES = 48
const WIDTH = 900
const HEIGHT = 500
const PADDING_X = 72
const PADDING_Y = 62

const abs = (value: bigint) => (value < 0n ? -value : value)
const max = (a: bigint, b: bigint) => (a > b ? a : b)

const shortAddress = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`

const ratio = (value: bigint, maximum: bigint) =>
  maximum > 0n ? Number((value * 10_000n) / maximum) / 10_000 : 0

const nodeRadius = (value: bigint, maximum: bigint) =>
  7 + Math.sqrt(ratio(value, maximum)) * 20

const scoreFor = (node: ScoreMove, stage: PreviewStage) =>
  stage === 'current' ? node.current : node.proposed

const edgeWeightFor = (edge: PreviewGraphEdge, stage: PreviewStage) =>
  stage === 'current' ? edge.currentWeight : edge.proposedWeight

const selectVisibleNodes = (
  nodes: ScoreMove[],
  currentSeeds: readonly Hex[],
  proposedSeeds: readonly Hex[]
) => {
  if (nodes.length <= MAX_VISIBLE_NODES) return [...nodes]

  const byPeakScore = [...nodes].sort((a, b) => {
    const aa = max(a.current, a.proposed)
    const bb = max(b.current, b.proposed)
    return aa === bb ? a.account.localeCompare(b.account) : aa > bb ? -1 : 1
  })
  const byMovement = [...nodes].sort((a, b) => {
    const aa = abs(a.delta)
    const bb = abs(b.delta)
    return aa === bb ? a.account.localeCompare(b.account) : aa > bb ? -1 : 1
  })
  const byAccount = new Map(
    nodes.map((node) => [node.account.toLowerCase(), node])
  )
  const selected = new Map<string, ScoreMove>()
  const add = (node: ScoreMove | undefined) => {
    if (node && selected.size < MAX_VISIBLE_NODES) {
      selected.set(node.account.toLowerCase(), node)
    }
  }

  for (const seed of [...currentSeeds, ...proposedSeeds]) {
    add(byAccount.get(seed.toLowerCase()))
  }
  for (const node of byMovement.slice(0, 14)) add(node)
  for (const node of byPeakScore) add(node)

  return Array.from(selected.values())
}

/** Deterministic force layout shared by both panels so movement is never a layout artifact. */
const layoutGraph = (
  nodes: ScoreMove[],
  edges: PreviewGraphEdge[]
): Map<string, Point> => {
  const ordered = [...nodes].sort((a, b) => a.account.localeCompare(b.account))
  if (ordered.length === 0) return new Map()
  if (ordered.length === 1) {
    return new Map([[ordered[0]!.account.toLowerCase(), { x: 450, y: 250 }]])
  }

  const positions = new Map<string, Point>()
  ordered.forEach((node, index) => {
    const angle = (index / ordered.length) * Math.PI * 2 - Math.PI / 2
    positions.set(node.account.toLowerCase(), {
      x: Math.cos(angle) * 0.7,
      y: Math.sin(angle) * 0.7,
    })
  })

  for (let iteration = 0; iteration < 110; iteration++) {
    const forces = new Map(
      ordered.map((node) => [node.account.toLowerCase(), { x: 0, y: 0 }])
    )

    for (let i = 0; i < ordered.length; i++) {
      const aKey = ordered[i]!.account.toLowerCase()
      const a = positions.get(aKey)!
      for (let j = i + 1; j < ordered.length; j++) {
        const bKey = ordered[j]!.account.toLowerCase()
        const b = positions.get(bKey)!
        const dx = a.x - b.x
        const dy = a.y - b.y
        const distanceSquared = dx * dx + dy * dy + 0.002
        const magnitude = 0.014 / distanceSquared
        const distance = Math.sqrt(distanceSquared)
        const fx = (dx / distance) * magnitude
        const fy = (dy / distance) * magnitude
        forces.get(aKey)!.x += fx
        forces.get(aKey)!.y += fy
        forces.get(bKey)!.x -= fx
        forces.get(bKey)!.y -= fy
      }
    }

    for (const edge of edges) {
      const sourceKey = edge.source.toLowerCase()
      const targetKey = edge.target.toLowerCase()
      if (sourceKey === targetKey) continue
      const source = positions.get(sourceKey)
      const target = positions.get(targetKey)
      if (!source || !target) continue
      const dx = target.x - source.x
      const dy = target.y - source.y
      const distance = Math.sqrt(dx * dx + dy * dy) || 0.001
      const magnitude = (distance - 0.28) * 0.025
      const fx = (dx / distance) * magnitude
      const fy = (dy / distance) * magnitude
      forces.get(sourceKey)!.x += fx
      forces.get(sourceKey)!.y += fy
      forces.get(targetKey)!.x -= fx
      forces.get(targetKey)!.y -= fy
    }

    const cooling = 0.24 * (1 - iteration / 110) + 0.035
    for (const node of ordered) {
      const key = node.account.toLowerCase()
      const point = positions.get(key)!
      const force = forces.get(key)!
      point.x += (force.x - point.x * 0.012) * cooling
      point.y += (force.y - point.y * 0.012) * cooling
      point.x = Math.max(-1.2, Math.min(1.2, point.x))
      point.y = Math.max(-1.2, Math.min(1.2, point.y))
    }
  }

  const values = Array.from(positions.values())
  const minX = Math.min(...values.map((point) => point.x))
  const maxX = Math.max(...values.map((point) => point.x))
  const minY = Math.min(...values.map((point) => point.y))
  const maxY = Math.max(...values.map((point) => point.y))
  const spanX = Math.max(maxX - minX, 0.01)
  const spanY = Math.max(maxY - minY, 0.01)

  for (const point of positions.values()) {
    point.x = PADDING_X + ((point.x - minX) / spanX) * (WIDTH - PADDING_X * 2)
    point.y = PADDING_Y + ((point.y - minY) / spanY) * (HEIGHT - PADDING_Y * 2)
  }
  return positions
}

const changeLabel = (move: ScoreMove) => {
  if (move.delta === 0n) return 'No score change'
  if (move.current === 0n) return 'New score'
  const percentage = Number((move.delta * 10_000n) / move.current) / 100
  return `${percentage > 0 ? '+' : ''}${percentage.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}%`
}

function GraphPanel({
  stage,
  nodes,
  edges,
  positions,
  maximumScore,
  maximumWeight,
  seeds,
  selectedAccount,
  onSelect,
}: {
  stage: PreviewStage
  nodes: ScoreMove[]
  edges: PreviewGraphEdge[]
  positions: Map<string, Point>
  maximumScore: bigint
  maximumWeight: bigint
  seeds: readonly Hex[]
  selectedAccount?: string
  onSelect: (account: string) => void
}) {
  const { resolvedTheme } = useTheme()
  const tokens = useMemo(() => readGraphTokens(), [resolvedTheme])
  const seedSet = useMemo(
    () => new Set(seeds.map((seed) => seed.toLowerCase())),
    [seeds]
  )
  const labelAccounts = useMemo(
    () =>
      new Set(
        [...nodes]
          .sort((a, b) => {
            const aa = scoreFor(a, stage)
            const bb = scoreFor(b, stage)
            return aa === bb ? 0 : aa > bb ? -1 : 1
          })
          .slice(0, 8)
          .map((node) => node.account.toLowerCase())
      ),
    [nodes, stage]
  )
  const markerId = `scoring-preview-arrow-${stage}`

  return (
    <div className="min-w-0 border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <p className="text-sm font-medium capitalize">{stage}</p>
        <p className="text-xs text-muted-foreground">
          Node size = simulated score
        </p>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="block aspect-[9/5] min-h-64 w-full"
        role="img"
        aria-label={`${stage} simulated TrustGraph`}
        style={{ background: tokens.canvas }}
      >
        <defs>
          <marker
            id={markerId}
            markerWidth="7"
            markerHeight="7"
            refX="6"
            refY="3.5"
            orient="auto"
          >
            <path d="M0,0 L7,3.5 L0,7 Z" fill={tokens.edgeStrong} />
          </marker>
        </defs>
        <g aria-hidden="true">
          {edges.map((edge) => {
            const source = positions.get(edge.source.toLowerCase())
            const target = positions.get(edge.target.toLowerCase())
            if (!source || !target) return null
            const sourceNode = nodes.find(
              (node) => node.account.toLowerCase() === edge.source.toLowerCase()
            )
            const targetNode = nodes.find(
              (node) => node.account.toLowerCase() === edge.target.toLowerCase()
            )
            if (!sourceNode || !targetNode) return null
            const dx = target.x - source.x
            const dy = target.y - source.y
            const distance = Math.sqrt(dx * dx + dy * dy)
            if (distance < 1) return null
            const sourceInset =
              nodeRadius(scoreFor(sourceNode, stage), maximumScore) + 2
            const targetInset =
              nodeRadius(scoreFor(targetNode, stage), maximumScore) + 5
            const weight = edgeWeightFor(edge, stage)
            return (
              <line
                key={`${edge.source}:${edge.target}`}
                x1={source.x + (dx / distance) * sourceInset}
                y1={source.y + (dy / distance) * sourceInset}
                x2={target.x - (dx / distance) * targetInset}
                y2={target.y - (dy / distance) * targetInset}
                stroke={tokens.edge}
                strokeWidth={
                  0.8 + Math.sqrt(ratio(weight, maximumWeight)) * 2.4
                }
                opacity={0.72}
                markerEnd={`url(#${markerId})`}
              />
            )
          })}
        </g>
        {nodes.map((node) => {
          const key = node.account.toLowerCase()
          const point = positions.get(key)
          if (!point) return null
          const score = scoreFor(node, stage)
          const radius = nodeRadius(score, maximumScore)
          const selected = key === selectedAccount?.toLowerCase()
          const trusted = seedSet.has(key)
          const changeStroke =
            stage === 'proposed' && node.delta > 0n
              ? 'var(--success)'
              : stage === 'proposed' && node.delta < 0n
                ? 'var(--error)'
                : tokens.nodeStroke
          return (
            <g
              key={node.account}
              role="button"
              tabIndex={0}
              aria-label={`${shortAddress(node.account)}, ${formatBigNumber(score, 18)} points, ${changeLabel(node)}`}
              onMouseEnter={() => onSelect(node.account)}
              onFocus={() => onSelect(node.account)}
              onClick={() => onSelect(node.account)}
              className="cursor-pointer outline-none"
            >
              {trusted && (
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={radius + 5}
                  fill="none"
                  stroke={tokens.labelHi}
                  strokeWidth="1.5"
                  strokeDasharray="3 3"
                  opacity="0.9"
                />
              )}
              <circle
                cx={point.x}
                cy={point.y}
                r={radius}
                fill={nodeColorForValue(
                  ratio(score, maximumScore) * 100,
                  tokens
                )}
                stroke={selected ? tokens.nodeSelected : changeStroke}
                strokeWidth={
                  selected
                    ? 4
                    : stage === 'proposed' && node.delta !== 0n
                      ? 3
                      : 1.5
                }
                className="transition-all duration-300"
              />
              {(labelAccounts.has(key) || selected) && (
                <text
                  x={point.x + radius + 5}
                  y={point.y + 4}
                  fill={selected ? tokens.labelHi : tokens.label}
                  fontFamily={tokens.fontFamily}
                  fontSize="12"
                  style={{ pointerEvents: 'none' }}
                >
                  {shortAddress(node.account)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export function ScoringGraphPreview({
  preview,
  currentSeeds,
  proposedSeeds,
}: {
  preview: ScoringPreview
  currentSeeds: readonly Hex[]
  proposedSeeds: readonly Hex[]
}) {
  const [display, setDisplay] = useState<'graph' | 'table'>('graph')
  const [mode, setMode] = useState<PreviewMode>('compare')
  const [selectedAccount, setSelectedAccount] = useState<string>()
  const nodes = useMemo(
    () => selectVisibleNodes(preview.graphNodes, currentSeeds, proposedSeeds),
    [currentSeeds, preview.graphNodes, proposedSeeds]
  )
  const nodeSet = useMemo(
    () => new Set(nodes.map((node) => node.account.toLowerCase())),
    [nodes]
  )
  const edges = useMemo(
    () =>
      preview.graphEdges.filter(
        (edge) =>
          nodeSet.has(edge.source.toLowerCase()) &&
          nodeSet.has(edge.target.toLowerCase())
      ),
    [nodeSet, preview.graphEdges]
  )
  const positions = useMemo(() => layoutGraph(nodes, edges), [edges, nodes])
  const maximumScore = useMemo(
    () =>
      nodes.reduce(
        (largest, node) => max(largest, max(node.current, node.proposed)),
        0n
      ),
    [nodes]
  )
  const maximumWeight = useMemo(
    () =>
      edges.reduce(
        (largest, edge) =>
          max(largest, max(edge.currentWeight, edge.proposedWeight)),
        0n
      ),
    [edges]
  )
  const selected =
    nodes.find(
      (node) => node.account.toLowerCase() === selectedAccount?.toLowerCase()
    ) ??
    [...nodes].sort((a, b) => {
      const aa = abs(a.delta)
      const bb = abs(b.delta)
      return aa === bb ? 0 : aa > bb ? -1 : 1
    })[0]
  const visibleStages: PreviewStage[] =
    mode === 'compare' ? ['current', 'proposed'] : [mode]
  const tableRows = useMemo(
    () =>
      [...preview.graphNodes].sort((a, b) => {
        const aa = abs(a.delta)
        const bb = abs(b.delta)
        return aa === bb ? a.account.localeCompare(b.account) : aa > bb ? -1 : 1
      }),
    [preview.graphNodes]
  )

  if (nodes.length === 0) {
    return (
      <div className="border border-border bg-surface-2 p-5 text-sm text-muted-foreground">
        The checkpoint has no active graph connections to visualize yet.
      </div>
    )
  }

  return (
    <section className="min-w-0 border border-border bg-surface-2 p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="tg-label">Graph simulation</p>
          <h3 className="mt-1 text-lg font-semibold">
            Current influence vs. proposed influence
          </h3>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
            Both views use the same checkpoint and locked node positions. Node
            size represents simulated score; edge width represents effective
            vouch weight. Connections do not move when switching views.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <div
            className="flex border border-border bg-background p-1"
            aria-label="Simulation format"
          >
            {(['graph', 'table'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={display === value}
                onClick={() => setDisplay(value)}
                className={cn(
                  'min-h-9 px-3 text-xs capitalize transition-colors',
                  display === value
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {value}
              </button>
            ))}
          </div>
          {display === 'graph' && (
            <div
              className="flex border border-border bg-background p-1"
              aria-label="Graph preview view"
            >
              {(
                [
                  ['current', 'Current'],
                  ['compare', 'Compare'],
                  ['proposed', 'Proposed'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                  className={cn(
                    'min-h-9 px-3 text-xs transition-colors',
                    mode === value
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {display === 'graph' ? (
        <>
          <div
            className={cn(
              'mt-4 grid gap-3',
              visibleStages.length === 2 && 'xl:grid-cols-2'
            )}
          >
            {visibleStages.map((stage) => (
              <GraphPanel
                key={stage}
                stage={stage}
                nodes={nodes}
                edges={edges}
                positions={positions}
                maximumScore={maximumScore}
                maximumWeight={maximumWeight}
                seeds={stage === 'current' ? currentSeeds : proposedSeeds}
                selectedAccount={selected?.account}
                onSelect={setSelectedAccount}
              />
            ))}
          </div>

          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full border-2 border-success" />
              Proposed score increases
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full border-2 border-error" />
              Proposed score decreases
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-full border border-dashed border-foreground" />
              Trusted account
            </span>
            <span>
              Showing {nodes.length} of {preview.graphNodes.length} accounts
            </span>
          </div>
        </>
      ) : (
        <div className="mt-4 overflow-x-auto border border-border bg-background">
          <table className="w-full min-w-[44rem] text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Account</th>
                <th className="p-3 text-right font-medium">Current</th>
                <th className="p-3 text-right font-medium">Proposed</th>
                <th className="p-3 text-right font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row) => (
                <tr key={row.account} className="border-t border-border">
                  <td className="p-3">
                    <CopyableText
                      text={row.account}
                      truncate
                      alwaysShowCopyIcon
                      className="max-w-full text-foreground"
                    />
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {formatBigNumber(row.current, 18)}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {formatBigNumber(row.proposed, 18)}
                  </td>
                  <td
                    className={cn(
                      'p-3 text-right font-medium tabular-nums',
                      row.delta > 0n && 'text-success',
                      row.delta < 0n && 'text-error'
                    )}
                  >
                    {changeLabel(row)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))]">
          <div className="min-w-0">
            <p className="tg-label">Selected account</p>
            <CopyableText
              text={selected.account}
              truncate
              alwaysShowCopyIcon
              className="mt-1 max-w-full text-foreground"
            />
          </div>
          <div>
            <p className="tg-label">Current</p>
            <p className="mt-1 text-sm tabular-nums">
              {formatBigNumber(selected.current, 18)} points
            </p>
          </div>
          <div>
            <p className="tg-label">Proposed</p>
            <p className="mt-1 text-sm tabular-nums">
              {formatBigNumber(selected.proposed, 18)} points
            </p>
          </div>
          <div>
            <p className="tg-label">Change</p>
            <p
              className={cn(
                'mt-1 text-sm font-medium tabular-nums',
                selected.delta > 0n && 'text-success',
                selected.delta < 0n && 'text-error'
              )}
            >
              {changeLabel(selected)}
            </p>
          </div>
        </div>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Simulation only: it recomputes this checkpoint with the draft settings.
        New or revoked attestations before the next proof can change the final
        graph.
      </p>
    </section>
  )
}
