import { ButtonLink } from '@/components/Button'
import { Card } from '@/components/Card'

/**
 * What a page shows when the network directory could not be read.
 *
 * The trust-graph directory is a runtime read from the indexer (GOAL.md M3). When that read
 * fails, the honest answer for an unrecognised network id is "we cannot tell you right now",
 * not "this network does not exist" — a 404 there would report a live community as nonexistent
 * on the strength of a failed HTTP request.
 */
export const CatalogUnavailable = ({
  reason,
  networkId,
}: {
  reason: string
  networkId?: string
}) => (
  <div className="flex flex-col justify-center items-center pt-12 gap-4 text-center">
    <h1>Network directory unavailable</h1>
    <p className="text-sm max-w-prose">
      We could not reach the service that lists networks, so we cannot tell
      whether{' '}
      {networkId ? (
        <span className="break-all font-bold">{networkId}</span>
      ) : (
        'this network'
      )}{' '}
      exists. Nothing is lost: networks live on chain, not here. Try again in a
      moment.
    </p>
    <p className="text-xs text-muted-foreground break-all max-w-prose">
      {reason}
    </p>
    <ButtonLink href="/networks" className="mt-4">
      View all networks
    </ButtonLink>
  </div>
)

/**
 * The same message as an inline strip, for pages that can still show a partial list.
 *
 * The reason is a raw Node error string ("fetch failed", "GET /instances responded 503"), and it
 * does not reach the page at all. It rendered in the card first, and then, once that was called
 * out, in a `title` attribute — which is worse rather than better: a browser draws `title` as a
 * tooltip for every sighted reader who happens to rest a pointer on the notice, so the string the
 * copy doc calls out as the one line that fails the plain-reader test was still on the public
 * surface, just harder to notice in review. Nor does it go in a data attribute, which was
 * the next thing tried: `data-reason="fetch failed"` is still the raw string in the DOM of a
 * public page. It is logged server-side by `lib/catalog.server.ts`, which is where whoever
 * is debugging this is already looking. The prop stays so the call-site keeps documenting
 * that a reason exists.
 *
 * The label is a real heading, not a bold paragraph. It names the notice, so a screen reader
 * needs somewhere to land, and `font-bold` on a single-weight face was synthesising a weight
 * the type system does not have.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const CatalogDegradedNotice = ({
  reason: _reason,
}: {
  reason: string
}) => (
  <Card type="accent" size="sm" className="space-y-1">
    <h2 className="tg-label-strong">Showing a partial list</h2>
    {/* "Networks created recently are missing" named the wrong set, and named
     * it too kindly. The fallback is `VISIBLE_SEED_NETWORKS`, a BUILD-TIME
     * import of the shipped config file, so what is missing is every network
     * ever created through the factory, whatever its age: one made a year ago
     * is exactly as absent as one made a minute ago. The page has never seen
     * any of them, so it could not tell you which were recent even if it
     * wanted to. */}
    <p className="max-w-prose text-sm">
      The service that lists networks could not be reached, so this page is
      showing only the networks the app shipped with. The ones below are still
      real.
    </p>
  </Card>
)
