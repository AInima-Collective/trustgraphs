'use client'

import type { UseQueryResult } from '@tanstack/react-query'
import { Check, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/Button'
import type { SafeAction } from '@/lib/actions'
import type { ProposalSimulation } from '@/lib/governance-simulation'
import { cn } from '@/lib/utils'

/**
 * The dry run of a proposal's legs from the treasury, shown on the review step. A revert here
 * is what execution would hit later, so it is worth reading before the vote starts.
 */
export function ProposalSimulationPanel({
  simulation,
  actions,
}: {
  simulation: UseQueryResult<ProposalSimulation>
  actions: readonly SafeAction[]
}) {
  const { data, isPending, isFetching, isError, error, refetch } = simulation
  const reverted = data?.legs.filter((leg) => leg.status === 'revert') ?? []
  const skipped = data?.legs.filter((leg) => leg.status === 'skipped') ?? []
  const allGood = !!data && reverted.length === 0

  return (
    <section
      aria-label="Dry run"
      className={cn(
        'space-y-3 border p-4 text-xs',
        isError
          ? 'border-border bg-surface'
          : reverted.length
            ? 'border-warn/40 bg-warn-soft'
            : allGood
              ? 'border-success/40 bg-success-soft'
              : 'border-border bg-surface'
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium">
          {isPending || isFetching ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          ) : isError ? (
            <TriangleAlert
              className="size-4 text-text-muted"
              aria-hidden="true"
            />
          ) : reverted.length ? (
            <TriangleAlert className="size-4 text-warn" aria-hidden="true" />
          ) : (
            <Check className="size-4 text-success" aria-hidden="true" />
          )}
          {isPending || isFetching
            ? 'Dry-running the calls from the treasury…'
            : isError
              ? 'Dry run unavailable'
              : reverted.length
                ? `${reverted.length} of ${actions.length} ${reverted.length === 1 ? 'call' : 'calls'} would revert right now`
                : `Every call succeeds against the current chain state`}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          <RefreshCw />
          Run again
        </Button>
      </div>
      {isError && (
        <p className="leading-relaxed text-text-muted">
          {error instanceof Error ? error.message : 'The node did not answer.'}
        </p>
      )}
      {data && (
        <ol className="space-y-1">
          {data.legs.map((leg, index) => (
            <li
              key={index}
              className={cn(
                'flex flex-wrap gap-x-2 leading-relaxed',
                leg.status === 'revert' ? 'text-text' : 'text-text-muted'
              )}
            >
              <span className="tabular-nums">Transaction {index + 1}:</span>
              {leg.status === 'success' && (
                <span>
                  succeeds
                  {leg.gasUsed !== undefined
                    ? ` (${leg.gasUsed.toLocaleString('en-US')} gas)`
                    : ''}
                </span>
              )}
              {leg.status === 'revert' && (
                <span className="break-words">
                  would revert{leg.reason ? `: ${leg.reason}` : ''}
                </span>
              )}
              {leg.status === 'skipped' && (
                <span>{leg.reason ?? 'not simulated'}</span>
              )}
            </li>
          ))}
        </ol>
      )}
      {data?.method === 'sequential' && (
        <p className="leading-relaxed text-text-muted">
          This node checks calls one at a time, so a later call that depends on
          an earlier one may still succeed when the proposal executes them
          together.
        </p>
      )}
      {skipped.length > 0 && data?.method === 'batch' && (
        <p className="leading-relaxed text-text-muted">
          Skipped calls are not covered by this dry run.
        </p>
      )}
      {allGood && (
        <p className="leading-relaxed text-text-muted">
          Chain state can change before execution; the proposal re-checks
          everything when it runs.
        </p>
      )}
    </section>
  )
}
