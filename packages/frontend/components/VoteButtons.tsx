'use client'

import { Button } from '@/components/Button'
import { VoteType } from '@/hooks/useGovernance'
import { cn } from '@/lib/utils'

type Props = {
  disabled?: boolean
  isLoading?: boolean
  selected?: VoteType | null
  onSelect: (voteType: VoteType) => void
}

/**
 * Three exclusive choices. Unselected is a hairline in the option's own
 * colour; selected fills solid. The ring-plus-tint treatment this replaced
 * made all three look pre-selected, so nothing signalled the actual choice.
 *
 * Abstain reads neutral on purpose — it is the absence of a position, not a
 * third position, so it never takes a hue.
 */
const OPTIONS: { vote: VoteType; label: string; on: string; off: string }[] = [
  {
    vote: VoteType.Yes,
    label: 'Vote for',
    on: 'border-success bg-success text-ink-fg hover:opacity-90',
    off: 'border-success/50 bg-transparent text-success hover:bg-success-soft',
  },
  {
    vote: VoteType.No,
    label: 'Vote against',
    on: 'border-error bg-error text-ink-fg hover:opacity-90',
    off: 'border-error/50 bg-transparent text-error hover:bg-error-soft',
  },
  {
    vote: VoteType.Abstain,
    label: 'Abstain',
    on: 'border-ink bg-ink text-ink-fg hover:opacity-90',
    off: 'border-border bg-transparent text-text-muted hover:bg-surface-2 hover:text-text',
  },
]

export function VoteButtons({
  disabled = false,
  isLoading = false,
  selected = null,
  onSelect,
}: Props) {
  const baseDisabled = disabled || isLoading

  return (
    <div
      role="radiogroup"
      aria-label="Cast a vote"
      className="flex flex-col gap-2 sm:flex-row"
    >
      {OPTIONS.map(({ vote, label, on, off }) => (
        <Button
          key={label}
          onClick={() => onSelect(vote)}
          disabled={baseDisabled}
          type="button"
          role="radio"
          aria-checked={selected === vote}
          variant="custom"
          className={cn('grow transition-colors', selected === vote ? on : off)}
        >
          {label}
        </Button>
      ))}
    </div>
  )
}
