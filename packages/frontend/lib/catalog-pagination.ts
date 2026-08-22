/**
 * Pagination mechanics for the runtime instance catalog.
 *
 * Kept separate from `catalog.ts` so the boundary can be tested without importing the generated
 * deployment config. Offset pagination cannot provide a database snapshot across requests, so we
 * fail closed when the endpoint exposes movement (a changed total or an overlapping row) instead
 * of returning a directory that only looks complete.
 */

export type CatalogPage<Row> = {
  instances: Row[]
  pagination: { limit: number; offset: number; total: number }
}

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const readPage = <Row>(
  body: unknown,
  requestedOffset: number
): CatalogPage<Row> => {
  if (!body || typeof body !== 'object') {
    throw new Error('GET /instances returned an unexpected body')
  }

  const page = body as Partial<CatalogPage<Row>>
  const pagination = page.pagination
  if (
    !Array.isArray(page.instances) ||
    !pagination ||
    !isNonNegativeSafeInteger(pagination.limit) ||
    !isNonNegativeSafeInteger(pagination.offset) ||
    !isNonNegativeSafeInteger(pagination.total)
  ) {
    throw new Error('GET /instances returned invalid pagination metadata')
  }
  if (pagination.limit === 0) {
    throw new Error('GET /instances returned a zero page limit')
  }
  if (pagination.offset !== requestedOffset) {
    throw new Error(
      `GET /instances returned offset ${pagination.offset} for requested offset ${requestedOffset}`
    )
  }
  if (page.instances.length > pagination.limit) {
    throw new Error('GET /instances returned more rows than its page limit')
  }

  return { instances: page.instances, pagination }
}

/**
 * Read every page from an offset-paginated `/instances` endpoint.
 *
 * `pagination.total` from the first response is the completion condition. Later pages must agree
 * with it, and row ids must be unique across the read. Any inconsistency throws so callers can
 * show their existing degraded-catalog warning rather than silently publish a truncated list.
 */
export const collectCatalogPages = async <Row extends { id: string }>(
  fetchPage: (offset: number) => Promise<unknown>
): Promise<CatalogPage<Row>> => {
  const instances: Row[] = []
  const ids = new Set<string>()
  let expectedTotal: number | null = null
  let firstLimit: number | null = null
  let offset = 0

  for (;;) {
    const page = readPage<Row>(await fetchPage(offset), offset)
    const { limit, total } = page.pagination

    if (expectedTotal === null) {
      expectedTotal = total
      firstLimit = limit
    } else if (total !== expectedTotal) {
      throw new Error(
        `GET /instances total changed during pagination (${expectedTotal} to ${total})`
      )
    }

    if (offset + page.instances.length > expectedTotal) {
      throw new Error('GET /instances returned more rows than its total')
    }
    if (page.instances.length === 0 && offset < expectedTotal) {
      throw new Error(
        `GET /instances pagination made no progress at offset ${offset}`
      )
    }

    for (const row of page.instances) {
      const id = row.id.toLowerCase()
      if (ids.has(id)) {
        throw new Error(
          `GET /instances repeated row ${row.id} during pagination`
        )
      }
      ids.add(id)
      instances.push(row)
    }

    offset += page.instances.length
    if (offset === expectedTotal) {
      return {
        instances,
        pagination: {
          limit: firstLimit!,
          offset: 0,
          total: expectedTotal,
        },
      }
    }

    // A stable SQL limit/offset endpoint fills every non-final page. Continuing after a short
    // page could skip rows if the dataset moved between requests, so treat it as unstable.
    if (page.instances.length < limit) {
      throw new Error(
        `GET /instances ended a page early at offset ${page.pagination.offset}`
      )
    }
  }
}
