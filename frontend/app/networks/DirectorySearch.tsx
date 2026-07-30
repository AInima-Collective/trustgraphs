'use client'

//! The filter, which only exists once the list is long enough to need it.
//!
//! The page decides that (12 rows and up) and renders this island around the same row components it
//! would otherwise render itself, so the rows are in the server HTML either way: with JavaScript
//! off, the directory is complete and readable and only the input goes inert.
//!
//! The filter is deliberately dumb — a case-insensitive substring of name and blurb, matched against
//! a haystack the server already lowercased. No fuzzy matching, no ranking: a reader typing "kelp"
//! is looking for Kelp Line, and a directory that reorders itself under them is harder to use than
//! one that just hides what does not match.

import { useMemo, useState } from 'react'

import { Input } from '@/components/Input'
import { cn } from '@/lib/utils'

import {
  DirectorySectionBlock,
  type DirectorySectionView,
} from './DirectoryList'

export const DirectorySearch = ({
  sections,
}: {
  sections: DirectorySectionView[]
}) => {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()

  const filtered = useMemo(() => {
    if (!needle) return sections
    return sections
      .map((section) => ({
        ...section,
        rows: section.rows.filter((row) => row.haystack.includes(needle)),
      }))
      .filter((section) => section.rows.length > 0)
  }, [needle, sections])

  return (
    <div className="space-y-8 sm:space-y-10">
      <div role="search">
        <label htmlFor="directory-filter" className="sr-only">
          Filter networks
        </label>
        <Input
          id="directory-filter"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter networks"
          autoComplete="off"
          spellCheck={false}
          // h-11 clears the 44px tap target that the 36px control default does
          // not. What stops iOS zooming on focus is the `pointer: coarse` block
          // in globals.css, NOT a utility here: `text-base` is 14px in this
          // system, which is under the 16px threshold and would cause the zoom
          // rather than prevent it.
          className="h-11 w-full sm:max-w-xs"
        />
      </div>

      {/* One persistent live region rather than a node that mounts with its message: a status
       * element that appears at the same moment as its text is not reliably announced. It carries
       * `sr-only` while there are results, so it takes no space and leaves no gap. */}
      <p
        role="status"
        className={cn('text-text-muted', filtered.length > 0 && 'sr-only')}
      >
        {filtered.length === 0 ? 'Nothing matches that.' : ''}
      </p>

      {filtered.map((section) => (
        <DirectorySectionBlock key={section.key} section={section} />
      ))}
    </div>
  )
}
