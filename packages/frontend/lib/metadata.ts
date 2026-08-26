import type { Metadata } from 'next'

// Social crawlers cache image URLs for much longer than the page metadata.
// Keep this path content-specific: when the card changes, publish it under a
// new name so an old crawler cache cannot keep the previous card alive.
export const SOCIAL_CARD_IMAGE =
  '/images/trustgraphs-social-card-trust-made-legible.png'

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
 * The image has a content-specific public path rather than the stable Next
 * file-convention route. It is named here rather than inherited for the same
 * reason as everything else in the object.
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
    images: [SOCIAL_CARD_IMAGE],
  },
  twitter: {
    card: 'summary_large_image',
    site: '@trustgraphs',
    creator: '@trustgraphs',
    title,
    description,
    images: [SOCIAL_CARD_IMAGE],
  },
  alternates: { canonical: path },
})
