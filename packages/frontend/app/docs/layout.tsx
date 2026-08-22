import './docs.css'

import type { ReactNode } from 'react'

import { DocsSidebar } from '@/components/DocsSidebar'

/**
 * Chrome shared by every /docs page: the tree on the left, the page on the
 * right. The sidebar is sticky and scrolls independently, so a long runbook
 * never strands the reader away from the map.
 *
 * Below lg the tree folds into a native <details> above the content — the
 * same disclosure pattern the questions page settled on, for the same
 * reasons: keyboard-complete for free, works without JavaScript, and the
 * browser's in-page search can see through it.
 */
export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full flex-col gap-6 lg:flex-row lg:items-start lg:gap-12">
      <details className="group border-b border-border pb-3 lg:hidden">
        <summary className="tg-label-strong flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink [&::-webkit-details-marker]:hidden">
          Documentation
          <svg
            aria-hidden="true"
            viewBox="0 0 12 12"
            className="h-3 w-3 shrink-0"
            fill="none"
          >
            <path d="M0 6 H12" stroke="currentColor" strokeWidth="1" />
            <path
              d="M6 0 V12"
              stroke="currentColor"
              strokeWidth="1"
              className="origin-center transition-transform group-open:scale-y-0"
            />
          </svg>
        </summary>
        <div className="pt-4">
          <DocsSidebar />
        </div>
      </details>

      <aside className="scrollbar-thin sticky top-6 hidden max-h-[calc(100vh-6rem)] w-52 shrink-0 overflow-y-auto pb-6 pr-1 lg:block">
        <DocsSidebar />
      </aside>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
