'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { DOCS_SECTIONS, DocGroup } from '@/lib/docs/manifest'
import { cn } from '@/lib/utils'

/**
 * The docs tree, rendered from lib/docs/manifest. Client-side only for
 * `usePathname` — the data is static and ships no fs or markdown code.
 *
 * The register matches the rest of the chrome: section names are mono
 * uppercase labels (they are apparatus), page links are sentence-case mono at
 * label size. The current page is full ink with a hairline marker in the left
 * gutter; everything else sits a tonal step down until hovered. The four
 * per-program groups are native <details>, closed unless the reader is inside
 * one — they are reference depth, not the reading path, and 33 always-open
 * links would bury the reading path they bracket.
 */

const ITEM =
  'flex min-h-8 items-center border-l pl-3 -ml-px text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink'

function GroupItems({
  group,
  pathname,
}: {
  group: DocGroup
  pathname: string
}) {
  return (
    <ul className="flex list-none flex-col border-l border-border p-0">
      {group.items.map((item) => {
        const href = `/docs/${item.slug}`
        const active = pathname === href
        return (
          <li key={item.slug}>
            <Link
              href={href}
              prefetch={false}
              aria-current={active ? 'page' : undefined}
              className={cn(
                ITEM,
                active
                  ? 'border-ink text-text'
                  : 'border-transparent text-text-muted hover:text-text'
              )}
            >
              {item.label}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

export function DocsSidebar() {
  const pathname = usePathname()

  return (
    <nav aria-label="Documentation" className="flex flex-col gap-8">
      {DOCS_SECTIONS.map((section) => {
        const sectionHref = `/docs/${section.dir}`
        return (
          <div key={section.dir} className="flex flex-col gap-2">
            <Link
              href={sectionHref}
              prefetch={false}
              aria-current={pathname === sectionHref ? 'page' : undefined}
              className={cn(
                'tg-label inline-flex min-h-6 items-center transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
                pathname === sectionHref && 'text-text'
              )}
            >
              {section.label}
            </Link>

            <div className="flex flex-col gap-2">
              {section.groups.map((group, i) => {
                const containsCurrent = group.items.some(
                  (item) => pathname === `/docs/${item.slug}`
                )

                if (!group.collapsible) {
                  return (
                    <div key={group.label ?? i}>
                      {group.label && (
                        <div className="tg-label mb-1 mt-2">{group.label}</div>
                      )}
                      <GroupItems group={group} pathname={pathname} />
                    </div>
                  )
                }

                return (
                  <details
                    key={group.label}
                    open={containsCurrent || undefined}
                    className="group"
                  >
                    <summary className="tg-label flex min-h-6 cursor-pointer list-none items-center justify-between gap-2 transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink [&::-webkit-details-marker]:hidden">
                      {group.label}
                      {/* State carried by shape, not colour: + closed, − open. */}
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 10 10"
                        className="h-2.5 w-2.5 shrink-0"
                        fill="none"
                      >
                        <path
                          d="M0 5 H10"
                          stroke="currentColor"
                          strokeWidth="1"
                        />
                        <path
                          d="M5 0 V10"
                          stroke="currentColor"
                          strokeWidth="1"
                          className="origin-center transition-transform group-open:scale-y-0"
                        />
                      </svg>
                    </summary>
                    <div className="pt-1">
                      <GroupItems group={group} pathname={pathname} />
                    </div>
                  </details>
                )
              })}
            </div>
          </div>
        )
      })}
    </nav>
  )
}
