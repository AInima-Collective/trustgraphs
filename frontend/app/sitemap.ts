import type { MetadataRoute } from 'next'

import { getCatalog } from '@/lib/catalog.server'
import {
  VISIBLE_CONTRIBUTIONS_NETWORKS,
  VISIBLE_HYPERCERTS_NETWORKS,
} from '@/lib/config'

/**
 * The sitemap.
 *
 * The three public pages are the point of it, and they are listed as
 * constants: a crawler must be able to find `/`, `/networks` and `/faq`
 * whether or not anything else in this system is answering.
 *
 * Every network the catalog knows about is listed after them, because
 * `/networks` promises every network on this chain and a directory nobody can
 * crawl into is half a directory. `getCatalog` never throws — an unreachable
 * indexer degrades to the shipped seed — so the worst case here is a short
 * sitemap, never a failed one.
 */

// Same window as the pages'. See CATALOG_REVALIDATE_SECONDS in catalog.server.ts.
export const revalidate = 10

const SITE = 'https://trustgraph.network'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const { networks } = await getCatalog()

  // The same three sources `/networks` groups its sections from, so the sitemap
  // and the directory list the same things. Funding rounds and repo-reputation
  // instances are static config, not a catalog read.
  const ids = [
    ...networks.map((network) => network.id),
    ...VISIBLE_CONTRIBUTIONS_NETWORKS.map((network) => network.id),
    ...VISIBLE_HYPERCERTS_NETWORKS.map((network) => network.id),
  ]

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
    ...ids.map((id) => ({
      url: `${SITE}/networks/${id}`,
      changeFrequency: 'hourly' as const,
      priority: 0.5,
    })),
  ]
}
