import type { MetadataRoute } from 'next'

import { DOCS_ORDER, DOCS_SECTIONS } from '@/lib/docs/manifest'

/**
 * The sitemap: the public pages, and nothing else.
 *
 * The app routes are deliberately absent. `/create` is a wizard that wants a
 * wallet, `/networks/[id]/*` are instrument screens whose numbers move every
 * round, and `/account/[address]` is a page about one stranger. None of them is
 * a thing a search result should land someone on, and a sitemap that listed
 * them would be a sitemap that needs the indexer to build.
 *
 * Constants, not a read. A crawler has to be able to find `/`, `/networks`,
 * `/faq` and the docs whether or not anything else in this system is
 * answering — the docs routes come from the manifest, which is compiled-in
 * data, not a filesystem or indexer read.
 */
const SITE = 'https://trustgraphs.xyz'

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE,
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${SITE}/networks`,
      changeFrequency: 'hourly',
      priority: 0.8,
    },
    {
      url: `${SITE}/faq`,
      changeFrequency: 'weekly',
      priority: 0.6,
    },
    {
      url: `${SITE}/docs`,
      changeFrequency: 'weekly',
      priority: 0.6,
    },
    ...DOCS_SECTIONS.map((section) => ({
      url: `${SITE}/docs/${section.dir}`,
      changeFrequency: 'weekly' as const,
      priority: 0.5,
    })),
    ...DOCS_ORDER.map((item) => ({
      url: `${SITE}/docs/${item.slug}`,
      changeFrequency: 'weekly' as const,
      priority: 0.4,
    })),
  ]
}
