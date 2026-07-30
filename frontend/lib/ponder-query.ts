import type { QueryKey } from '@tanstack/react-query'

/**
 * Make a ponder single-row query safe for TanStack Query.
 *
 * Drizzle's `findFirst` resolves to `undefined` when there is no row. TanStack Query treats an
 * `undefined` result as a broken query function and throws rather than rendering "no data":
 *
 *     Error: Query data cannot be undefined. Please make sure to return a value other than
 *     undefined from your query function.
 *
 * So an ordinary miss — a Safe that does not exist, a snapshot the indexer has not reached yet —
 * surfaces as an unhandled error and a blank page. This maps it to `null`.
 *
 * **Why it wraps the OPTIONS and not the query function.** `usePonderQuery` requires its `queryFn`
 * to hand back the drizzle query *builder*, because ponder executes it once up front to compile the
 * SQL that becomes the query key. Wrapping the function itself in a promise breaks that with
 * `"queryFn" must return SQL`, which typechecks fine and only fails at run time. By the time
 * `usePonderQueryOptions` / `getPonderQueryOptions` have returned, the key is already built, so
 * replacing `queryFn` here is free.
 *
 * Use it on any `findFirst`-backed query, on both the client and the server prefetch — a prefetch
 * that resolves `undefined` poisons the dehydrated cache and throws during hydration, before any
 * component-level guard can help.
 */
export const nullable = <T>(options: {
  queryKey: QueryKey
  queryFn: () => PromiseLike<T | undefined>
}): { queryKey: QueryKey; queryFn: () => Promise<T | null> } => ({
  queryKey: options.queryKey,
  queryFn: () => Promise.resolve(options.queryFn()).then((row) => row ?? null),
})
