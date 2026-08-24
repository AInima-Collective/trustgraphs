import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { CopyForLlmsButton } from '@/components/CopyForLlmsButton'
import { PageTitle, SectionHeading } from '@/components/SectionHeading'
import {
  DOCS_ORDER,
  DOCS_SECTIONS,
  REPO_URL,
  getDocItem,
  getSection,
} from '@/lib/docs/manifest'
import { getDoc, getDocSummary } from '@/lib/docs/server'
import { socialCard } from '@/lib/metadata'

/**
 * One docs page: `/docs/learn/faq` renders `docs/learn/faq.md`; a bare
 * section path (`/docs/learn`) renders that section's table of contents.
 *
 * The set of routes is closed over the manifest (`dynamicParams = false`), so
 * an unlisted path is a 404 rather than a filesystem probe — `getDoc` guards
 * traversal anyway, but the route table should not depend on it.
 */

export const dynamicParams = false

export function generateStaticParams() {
  return [
    ...DOCS_SECTIONS.map((section) => ({ slug: [section.dir] })),
    ...DOCS_ORDER.map((item) => ({ slug: item.slug.split('/') })),
  ]
}

type Props = { params: Promise<{ slug: string[] }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const path = slug.join('/')

  const section = slug.length === 1 ? getSection(path) : undefined
  if (section) {
    return {
      title: `${section.label} · Docs`,
      ...socialCard({
        title: `${section.label} · Docs | trustgraphs`,
        description: section.blurb,
        path: `/docs/${path}`,
      }),
    }
  }

  const summary = getDocItem(path) && getDocSummary(path)
  if (!summary) return {}
  return {
    title: summary.title,
    ...socialCard({
      title: `${summary.title} | trustgraphs`,
      description: summary.description,
      path: `/docs/${path}`,
    }),
  }
}

function SectionIndex({ dir }: { dir: string }) {
  const section = getSection(dir)
  if (!section) notFound()

  return (
    <div className="mx-auto w-full max-w-[72ch]">
      <nav
        aria-label="Breadcrumb"
        className="tg-label mb-3 flex items-center gap-2"
      >
        <Link
          href="/docs"
          prefetch={false}
          className="transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          Docs
        </Link>
      </nav>
      <PageTitle>{section.label}</PageTitle>
      <p className="text-lg text-text-muted">{section.blurb}</p>

      {section.groups.map((group, i) => (
        <section
          key={group.label ?? i}
          className="mt-12"
          aria-label={group.label ?? section.label}
        >
          {group.label && <SectionHeading>{group.label}</SectionHeading>}
          <ul className="list-none p-0">
            {group.items.map((item) => {
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

export default async function DocPage({ params }: Props) {
  const { slug } = await params
  const path = slug.join('/')

  if (slug.length === 1 && getSection(path)) {
    return <SectionIndex dir={path} />
  }

  const item = getDocItem(path)
  const doc = item && getDoc(path)
  if (!item || !doc) notFound()

  const section = getSection(slug[0])
  const index = DOCS_ORDER.findIndex((entry) => entry.slug === path)
  const prev = index > 0 ? DOCS_ORDER[index - 1] : undefined
  const next = index < DOCS_ORDER.length - 1 ? DOCS_ORDER[index + 1] : undefined

  // The table of contents renders inline under the title (h2 entries only, and
  // only when there are enough to be worth a map). A single numbered rail
  // preserves document order at every viewport and keeps the reading column
  // stable between pages.
  const contents = doc.toc.filter((entry) => entry.depth === 2)

  return (
    <div className="w-full">
      <article className="mx-auto min-w-0 max-w-[72ch]">
        <nav
          aria-label="Breadcrumb"
          className="tg-label mb-3 flex items-center gap-2"
        >
          <Link
            href="/docs"
            prefetch={false}
            className="transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Docs
          </Link>
          {section && (
            <>
              <span aria-hidden="true">/</span>
              <Link
                href={`/docs/${section.dir}`}
                prefetch={false}
                className="transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                {section.label}
              </Link>
            </>
          )}
        </nav>

        <header className="flex flex-col items-start gap-4 sm:flex-row sm:justify-between">
          {/* `break-words`: doc H1s carry unbreakable identifiers
           * ("TrustAwarePageRank:") that overflow a 320px viewport otherwise. */}
          <PageTitle className="tg-doc-title min-w-0 break-words">
            {doc.title}
          </PageTitle>
          <CopyForLlmsButton markdown={doc.markdown} />
        </header>

        {contents.length >= 3 && (
          <nav
            aria-label="Contents"
            className="mt-9 border-l border-border-strong pl-4 sm:pl-5"
          >
            <div className="tg-label-strong mb-2">Contents</div>
            <ol className="list-none p-0 text-sm">
              {contents.map((entry, index) => (
                <li key={entry.id}>
                  <a
                    href={`#${entry.id}`}
                    className="group grid min-h-9 grid-cols-[2.25rem_minmax(0,1fr)] items-baseline gap-2 py-1 text-text-muted transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    <span aria-hidden="true" className="tg-marker">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="underline-offset-4 group-hover:underline">
                      {entry.text}
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        )}

        <div
          className="tg-prose mt-6"
          // Server-rendered from the repo's own markdown; nothing user-supplied
          // reaches this string, and inline HTML in the source is escaped by
          // the renderer rather than passed through.
          dangerouslySetInnerHTML={{ __html: doc.html }}
        />

        <footer className="mt-14 flex flex-col gap-4 border-t border-border pt-4">
          <nav
            aria-label="Adjacent pages"
            className="flex justify-between gap-4"
          >
            {prev ? (
              <Link
                href={`/docs/${prev.slug}`}
                prefetch={false}
                className="group flex min-h-11 flex-col justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                <span className="tg-label">← Previous</span>
                <span className="text-sm text-text-muted transition-colors group-hover:text-text">
                  {prev.label}
                </span>
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link
                href={`/docs/${next.slug}`}
                prefetch={false}
                className="group flex min-h-11 flex-col items-end justify-center text-right focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                <span className="tg-label">Next →</span>
                <span className="text-sm text-text-muted transition-colors group-hover:text-text">
                  {next.label}
                </span>
              </Link>
            )}
          </nav>

          <a
            href={`${REPO_URL}/blob/HEAD/${doc.sourcePath}`}
            target="_blank"
            rel="noopener noreferrer"
            className="tg-label inline-flex min-h-11 items-center self-end transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Page source ↗
          </a>
        </footer>
      </article>
    </div>
  )
}
