import { cache } from 'react'

import {
  fetchContributionsNetwork,
  loadContributionsCatalog,
} from './contributions-catalog'

/** Keep in lockstep with the trust catalog's revalidation window (lib/catalog.server.ts). */
const CONTRIBUTIONS_CATALOG_REVALIDATE_SECONDS = 10

/**
 * Resolve one contributions round by instance id (or snapshot address) for a server component.
 * Memoized per request; `round` is null when the id is genuinely unknown, `error` is set when the
 * round catalog could not be read at all — 404ing on the second case would report a round as
 * non-existent on the strength of a failed HTTP request.
 */
export const getContributionsNetwork = cache(async (id: string) =>
  fetchContributionsNetwork(id, {
    next: { revalidate: CONTRIBUTIONS_CATALOG_REVALIDATE_SECONDS },
  })
)

/** The whole round catalog (optionally one parent's), memoized per request. */
export const getContributionsCatalog = cache(
  async (parentInstanceId?: `0x${string}`) =>
    loadContributionsCatalog(parentInstanceId, {
      next: { revalidate: CONTRIBUTIONS_CATALOG_REVALIDATE_SECONDS },
    })
)
