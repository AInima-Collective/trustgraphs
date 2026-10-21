/** How a proposal state reads: open for votes, settled for, settled against, or neither. */
export type StateTone = 'active' | 'positive' | 'negative' | 'muted'

const TONE_STYLES: Record<StateTone, string> = {
  active: 'border-success/50 bg-success-soft text-success',
  positive: 'border-hairline-strong bg-surface-2 text-text',
  negative: 'border-error/50 bg-error-soft text-error',
  muted: 'border-border bg-muted text-muted-foreground',
}

export const StateBadge = ({
  tone,
  label,
}: {
  tone: StateTone
  label: string
}) => (
  <span
    className={`text-xs px-2 py-1 rounded-md border font-medium whitespace-nowrap ${TONE_STYLES[tone]}`}
  >
    {label}
  </span>
)

/**
 * One stacked bar: For (success) / Against (error) / Abstain (neutral). Shares are of the votes
 * cast unless `total` is given, in which case the bar's unfilled end is the part never cast.
 */
export const ResultBar = ({
  forVotes,
  against,
  abstain,
  total,
}: {
  forVotes: bigint
  against: bigint
  abstain: bigint
  total?: bigint
}) => {
  const denominator = Number(total ?? forVotes + against + abstain)

  if (forVotes + against + abstain === 0n || denominator === 0) {
    return <span className="text-xs text-muted-foreground">No votes yet</span>
  }

  const pct = (v: bigint) => (Number(v) / denominator) * 100

  return (
    <div className="min-w-[120px] space-y-1">
      <div
        className="flex h-2 w-full overflow-hidden bg-surface-2"
        role="img"
        aria-label={`For ${pct(forVotes).toFixed(0)}%, against ${pct(against).toFixed(0)}%, abstain ${pct(abstain).toFixed(0)}%`}
      >
        <div
          className="bg-success h-2"
          style={{ width: `${pct(forVotes)}%` }}
        />
        <div className="bg-error h-2" style={{ width: `${pct(against)}%` }} />
        <div
          className="bg-text-subtle h-2"
          style={{ width: `${pct(abstain)}%` }}
        />
      </div>
      <div className="text-xs text-muted-foreground tabular-nums">
        {pct(forVotes).toFixed(0)}% for
      </div>
    </div>
  )
}
