import type { Metadata } from 'next'
import Link from 'next/link'

import { PageTitle, SectionHeading } from '@/components/SectionHeading'
import { DOCS_SECTIONS, DOCS_TASKS, getDocItem } from '@/lib/docs/manifest'
import { getDocSummary } from '@/lib/docs/server'
import { socialCard } from '@/lib/metadata'

/**
 * The docs front door: the four sections in reading order, each page with the
 * first sentence of its own markdown under it. The content comes from the
 * repo's docs/ tree at render time — this page lists it, it does not copy it.
 */
const DESCRIPTION =
  'How trustgraphs works, how to run a network of your own, and how to check the results: plain-language explainers through operator runbooks.'

export const metadata: Metadata = {
  title: 'Docs',
  ...socialCard({
    title: 'Docs | trustgraphs',
    description: DESCRIPTION,
    path: '/docs',
  }),
}

const numbered = (i: number) => String(i + 1).padStart(2, '0')

export default function DocsIndexPage() {
  return (
    <div className="mx-auto w-full max-w-[72ch]">
      <PageTitle>Documentation</PageTitle>

      {/* The task index. Faster than the sitemap when the reader arrives with
          a goal instead of a topic. */}
      <nav aria-label="By what you're trying to do" className="mt-10">
        <SectionHeading>{'I want to…'}</SectionHeading>
        <ul className="list-none p-0">
          {DOCS_TASKS.map((task) => {
            const item = getDocItem(task.slug)
            if (!item) return null
            return (
              <li key={task.slug} className="border-b border-border">
                <Link
                  href={`/docs/${task.slug}`}
                  prefetch={false}
                  className="group flex min-h-11 flex-col justify-center gap-x-4 gap-y-0.5 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink sm:flex-row sm:items-baseline sm:justify-between"
                >
                  <span className="text-text">{task.want}</span>
                  <span className="shrink-0 text-sm text-text-muted underline underline-offset-2 transition-colors group-hover:text-text">
                    {item.label}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      {DOCS_SECTIONS.map((section, i) => (
        <section
          key={section.dir}
          aria-label={section.label}
          className="mt-16 scroll-mt-6"
          id={section.dir}
        >
          <SectionHeading
            n={numbered(i)}
            actions={
              <Link
                href={`/docs/${section.dir}`}
                prefetch={false}
                className="tg-label transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                All →
              </Link>
            }
          >
            {section.label}
          </SectionHeading>
          <p className="mt-3 text-text-muted">{section.blurb}</p>

          <ul className="mt-2 grid list-none grid-cols-1 gap-x-8 p-0 sm:grid-cols-2">
            {section.groups
              .flatMap((group) => group.items)
              .map((item) => {
                const summary = getDocSummary(item.slug)
                return (
                  <li key={item.slug} className="border-b border-border">
                    <Link
                      href={`/docs/${item.slug}`}
                      prefetch={false}
                      className="group block py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                    >
                      <span className="text-text underline-offset-2 group-hover:underline">
                        {item.label}
                      </span>
                      {summary?.description && (
                        <span className="mt-0.5 line-clamp-2 block text-sm text-text-muted">
                          {summary.description}
                        </span>
                      )}
                    </Link>
                  </li>
                )
              })}
          </ul>
        </section>
      ))}
    </div>
  )
}
