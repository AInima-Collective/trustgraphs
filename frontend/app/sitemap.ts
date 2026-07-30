import type { MetadataRoute } from 'next'

/**
 * The sitemap: the three public pages, and nothing else.
 *
 * The app routes are deliberately absent. `/create` is a wizard that wants a
 * wallet, `/networks/[id]/*` are instrument screens whose numbers move every
 * round, and `/account/[address]` is a page about one stranger. None of them is
 * a thing a search result should land someone on, and a sitemap that listed
 * them would be a sitemap that needs the indexer to build.
 *
 * Constants, not a read. A crawler has to be able to find `/`, `/networks` and
 * `/faq` whether or not anything else in this system is answering.
 */
const SITE = 'https://trustgraph.network'

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
  ]
}
