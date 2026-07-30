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
 * The reason is a raw Node error string ("fetch failed", "GET /instances responded 503"). It used
 * to render in the card, where it is the one line on the public surface that fails the
 * plain-reader test. It is carried in `title` instead: available to anyone debugging, absent from
 * the reading experience.
 *
 * The label is a real heading, not a bold paragraph. It names the notice, so a screen reader
 * needs somewhere to land, and `font-bold` on a single-weight face was synthesising a weight
 * the type system does not have.
 */
export const CatalogDegradedNotice = ({ reason }: { reason: string }) => (
  <Card type="accent" size="sm" className="space-y-1" title={reason}>
    <h2 className="tg-label-strong">Showing a partial list</h2>
    <p className="text-sm">
      The service that lists networks could not be reached, so networks created
      recently are missing from this page. The ones below are still real.
    </p>
  </Card>
)
