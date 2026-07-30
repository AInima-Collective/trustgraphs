import type { MetadataRoute } from 'next'

/**
 * robots.txt.
 *
 * Everything a person can read, a crawler can read: the scoreboard argument
 * only works if the pages making it are public. The two exclusions are not
 * pages. `/api/` is the IPFS and RPC proxy, which returns JSON to the app and
 * nothing a search result should ever point at, and `/_next/` is build output.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/_next/'],
    },
    sitemap: 'https://trustgraph.network/sitemap.xml',
  }
}
