'use client'

import { ArrowUpRight, Plus, Search, Shield, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/Button'
import { GovernanceActionEmoji } from '@/components/GovernanceActionEmoji'
import {
  type GovernanceComposerActionKey,
  governanceComposerRegistry,
} from '@/lib/actions'
import { cn } from '@/lib/utils'

export const governanceCategoryLabels: Record<string, string> = {
  treasury: 'Treasury',
  scoring: 'Scoring',
  network: 'Network',
  membership: 'Membership',
  governance: 'Governance',
  safety: 'Safety',
  vault: 'Proving vault',
  programs: 'Programs',
  custom: 'Custom',
}

export function GovernanceActionLibrary({
  definitions,
  onAdd,
}: {
  definitions: readonly (typeof governanceComposerRegistry)[number][]
  onAdd: (key: GovernanceComposerActionKey) => void
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const categories = [
    ...new Set(definitions.map((definition) => definition.category)),
  ]
  const filtered = useMemo(
    () =>
      definitions.filter(
        (definition) =>
          (category === 'all' || definition.category === category) &&
          `${definition.label} ${definition.summary} ${governanceCategoryLabels[definition.category]}`
            .toLowerCase()
            .includes(query.trim().toLowerCase())
      ),
    [category, definitions, query]
  )

  return (
    <aside
      id="action-library"
      aria-labelledby="action-library-heading"
      className="min-w-0 scroll-mt-6 border border-border bg-surface lg:sticky lg:top-6 lg:self-start"
    >
      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <h4 id="action-library-heading" className="text-sm font-medium">
            Action library
          </h4>
          <span className="text-xs tabular-nums text-text-muted">
            {definitions.length} available
          </span>
        </div>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-3 size-4 text-text-muted"
            aria-hidden="true"
          />
          <input
            id="action-search"
            type="search"
            aria-label="Search actions"
            placeholder="Find an action…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-10 w-full border border-hairline-strong bg-background pl-9 pr-9 text-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear action search"
              onClick={() => setQuery('')}
              className="absolute right-0 top-0 flex size-10 items-center justify-center text-text-muted hover:text-text"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        <div
          role="group"
          aria-label="Filter actions by category"
          className="flex flex-wrap gap-1.5"
        >
          {['all', ...categories].map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={category === item}
              onClick={() => setCategory(item)}
              className={cn(
                'min-h-8 border px-2.5 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
                category === item
                  ? 'border-ink bg-ink text-ink-fg'
                  : 'border-border text-text-muted hover:border-hairline-strong hover:text-text'
              )}
            >
              {item === 'all' ? 'All actions' : governanceCategoryLabels[item]}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between border-y border-border bg-surface-2 px-4 py-2 sm:px-5">
        <span className="tg-label">
          {category === 'all'
            ? 'Explore actions'
            : governanceCategoryLabels[category]}
        </span>
        <span role="status" className="text-xs text-text-muted">
          {filtered.length} {filtered.length === 1 ? 'action' : 'actions'}
        </span>
      </div>
      <div className="max-h-80 overflow-y-auto overscroll-contain lg:max-h-[32rem]">
        {filtered.length ? (
          filtered.map((definition) => (
            <button
              key={definition.key}
              type="button"
              onClick={() => onAdd(definition.key)}
              aria-label={`Add ${definition.label}`}
              className="group flex w-full items-start gap-3 border-b border-border px-4 py-4 text-left transition-colors last:border-b-0 hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink sm:px-5"
            >
              <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center border border-border text-text-muted group-hover:border-hairline-strong group-hover:text-text">
                <GovernanceActionEmoji actionKey={definition.key} />
              </span>
              <span className="min-w-0 flex-1 space-y-1">
                <span className="block text-sm font-medium">
                  {definition.label}
                </span>
                <span className="block text-xs leading-relaxed text-text-muted">
                  {definition.summary}
                </span>
                {definition.danger && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-warn">
                    <Shield className="size-3" aria-hidden="true" />
                    High impact
                  </span>
                )}
              </span>
              <Plus
                className="mt-2 size-4 shrink-0 text-text-muted group-hover:text-text"
                aria-hidden="true"
              />
            </button>
          ))
        ) : (
          <div className="space-y-3 px-5 py-10 text-center">
            <Search
              className="mx-auto size-5 text-text-muted"
              aria-hidden="true"
            />
            <p className="text-sm">No matching actions</p>
            <p className="text-xs text-text-muted">
              Try another term or explore all categories.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery('')
                setCategory('all')
              }}
            >
              Clear filters
            </Button>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border px-4 py-3 text-xs text-text-muted sm:px-5">
        <ArrowUpRight className="size-3.5 shrink-0" aria-hidden="true" />
        Select an action to add it to your proposal.
      </div>
    </aside>
  )
}
