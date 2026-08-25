import type { MetadataRoute } from 'next'

/**
 * robots.txt.
 *
 * Everything a person can read, a crawler can read: the scoreboard argument
 * only works if the pages making it are public.
 *
 * ONE exclusion, and it is not a page: `/api/` is the IPFS and RPC proxy, which
 * returns JSON to the app and nothing a search result should ever point at.
 *
 * `/_next/` was in this list and should not have been. It is where the only
 * stylesheet on the site lives, and a crawler that cannot fetch the CSS cannot
 * render the page it is indexing. Blocking build output looks tidy and breaks
 * the thing the file exists to help.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/'],
    },
    sitemap: 'https://trustgraphs.xyz/sitemap.xml',
  }
}
