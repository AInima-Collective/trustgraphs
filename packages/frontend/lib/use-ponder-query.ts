'use client'

import type { Client } from '@ponder/client'
import {
  getPonderQueryOptions,
  usePonderClient,
  usePonderQuery as usePonderQueryUnguarded,
} from '@ponder/react'
import type { ResolvedSchema } from '@ponder/react'
import {
  type DefaultError,
  type UseQueryOptions,
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'

import { type Nulled, nullable } from './ponder-query'
import {
  REVIEW_FIXTURES_ENABLED,
  getReviewFixture,
} from './review-fixture-query'

/**
 * `usePonderQuery`, but a missing row is data rather than a crash.
 *
 * **Import this instead of `@ponder/react`'s.** A `findFirst` that matches nothing is an ordinary
 * state — the indexer has not reached that block, or is not watching that contract at all — and
 * with the upstream hook it takes down the page it is on. Guarding call sites one at a time does
 * not hold: exactly one of five `findFirst` queries had the guard, and among the four that did not
 * was the gov module, which left a network page rendering "Query data cannot be undefined" for a
 * module the indexer had never been pointed at.
 *
 * A composition of `usePonderClient` + `getPonderQueryOptions` + `useQuery`, mirroring
 * @ponder/react 0.16.2's own hook so the live subscription still works: SQL is compiled from the
 * builder up front (which is why `nullable` rewrites the OPTIONS and never the query function),
 * and pushed updates land under the same key. `findMany` queries pass through unchanged — an
 * array is never `undefined`, in the types (see `Nulled`) as well as at run time.
 */
export function usePonderQuery<
  queryFnData = unknown,
  error = DefaultError,
  data = Nulled<queryFnData>,
>(
  params: {
    queryFn: (db: Client<ResolvedSchema>['db']) => PromiseLike<queryFnData>
    live?: boolean
  } & Omit<
    UseQueryOptions<Nulled<queryFnData>, error, data>,
    'queryFn' | 'queryKey'
  >
): UseQueryResult<data, error>

export function usePonderQuery(params: any): any {
  const {
    queryFn,
    live: liveOption,
    ...rest
  } = params as {
    queryFn: (db: Client<ResolvedSchema>['db']) => PromiseLike<unknown>
    live?: boolean
    enabled?: boolean
  }
  const live = liveOption ?? true
  const queryClient = useQueryClient()
  const client = usePonderClient()
  // localStorage selects the review phase/persona, so it cannot participate in
  // SSR. Keep the first browser render identical to the server, then activate
  // the local fixture after hydration. Supplying it as a local query function
  // (instead of initialData) also works when React Query already created the
  // pending cache entry during SSR.
  const [reviewFixtureReady, setReviewFixtureReady] = useState(false)
  useEffect(() => setReviewFixtureReady(true), [])
  const reviewFixture = reviewFixtureReady
    ? getReviewFixture(queryFn)
    : undefined

  // Deliberately keyed on the query function alone, as upstream does: `ponderQueryFns.getX(addr)`
  // returns a fresh closure every render, so this recomputes every render and that is fine — it
  // is a SQL compile, not a fetch. (`client` is intentionally not a dependency, matching
  // @ponder/react; it is stable for the life of the provider.)
  const options = useMemo(
    () => getPonderQueryOptions(client, queryFn),
    [queryFn]
  )

  useEffect(() => {
    if (REVIEW_FIXTURES_ENABLED || live === false || rest.enabled === false)
      return
    // `options.queryFn` is nullary — it closes over the already-compiled query — while `live`
    // types its first argument as `(db) => Promise<T>`. Upstream passes exactly this and relies on
    // the extra argument being ignored; the cast records that rather than hiding it.
    const subscribe = client.live as unknown as (
      queryFn: () => PromiseLike<unknown>,
      onData: (data: unknown) => void
    ) => { unsubscribe: () => void }
    const { unsubscribe } = subscribe(options.queryFn, (data: unknown) => {
      // `?? null` for the same reason as `nullable`: a live push of "no row" must not poison the
      // cache with undefined.
      queryClient.setQueryData(options.queryKey, data ?? null)
    })
    return unsubscribe
  }, [
    live,
    rest.enabled,
    client,
    options.queryFn,
    options.queryKey,
    queryClient,
  ])

  return useQuery({
    ...rest,
    ...nullable(options),
    ...(REVIEW_FIXTURES_ENABLED
      ? {
          enabled: reviewFixtureReady && reviewFixture !== undefined,
          queryFn: async () => reviewFixture?.data,
          staleTime: Infinity,
          gcTime: Infinity,
        }
      : {}),
  })
}

/**
 * Escape hatch for the one case the guard would be wrong: a query whose `undefined` you want to
 * treat as a hard error. Nothing uses it today; it exists so reaching for the raw hook is a
 * deliberate, greppable act rather than an import that looks identical to the safe one.
 */
export { usePonderQueryUnguarded }
