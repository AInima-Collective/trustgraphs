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
    <ButtonLink href="/network" className="mt-4">
      View all networks
    </ButtonLink>
  </div>
)

/** The same message as an inline strip, for pages that can still show a partial list. */
export const CatalogDegradedNotice = ({ reason }: { reason: string }) => (
  <Card type="accent" size="sm" className="space-y-1">
    <p className="text-sm font-bold">SHOWING A PARTIAL LIST</p>
    <p className="text-sm">
      The service that lists networks could not be reached, so networks created
      recently are missing from this page. The ones below are still real.
    </p>
    <p className="text-xs text-muted-foreground break-all">{reason}</p>
  </Card>
)
