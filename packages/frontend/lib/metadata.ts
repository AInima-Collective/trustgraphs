import type { Metadata } from 'next'

/**
 * The share card for one public route.
 *
 * WHY THIS EXISTS. Next's metadata merge is shallow: a page that sets its own
 * `openGraph` or `twitter` object REPLACES the layout's rather than extending
 * it. Setting only `openGraph` per route gave each URL a Slack unfurl and an X
 * card carrying different sentences; setting both by hand then dropped
 * `card: summary_large_image`, `site`, `creator` and, on two routes, the image
 * entirely, because those live in the object that was replaced. Both of those
 * were mine, one round apart, which is what a helper is for.
 *
 * The image paths are the file-convention routes Next generates from
 * `app/opengraph-image.png` and `app/twitter-image.png`. They are named here
 * rather than inherited for the same reason as everything else in the object.
 */
export const socialCard = ({
  title,
  description,
  path,
}: {
  title: string
  description: string
  /** Route path, leading slash. Becomes `og:url` and the canonical. */
  path: string
}): Metadata => ({
  description,
  openGraph: {
    type: 'website',
    siteName: 'Trustgraphs',
    title,
    description,
    url: path,
    images: ['/opengraph-image.png'],
  },
  twitter: {
    card: 'summary_large_image',
    site: '@trustgraphs',
    creator: '@trustgraphs',
    title,
    description,
    images: ['/twitter-image.png'],
  },
  alternates: { canonical: path },
})
