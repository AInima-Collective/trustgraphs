/**
 * A deliberately tiny seam between the contributions review fixtures and the
 * Ponder hook. Query factories opt in by attaching a lazy value; production
 * builds never read it because the public review flag is off.
 */

export const REVIEW_FIXTURES_ENABLED =
  process.env.NEXT_PUBLIC_TG_REVIEW_FIXTURES === '1'

type FixtureResult = { data: unknown }
type FixtureQuery = {
  __tgReviewFixture?: () => FixtureResult | undefined
}

export const withReviewFixture = <T extends (...args: any[]) => any>(
  queryFn: T,
  fixture: () => unknown
): T => {
  if (REVIEW_FIXTURES_ENABLED) {
    ;(queryFn as T & FixtureQuery).__tgReviewFixture = () => {
      // Do not seed server-rendered query caches with the default persona or
      // phase. The screenshot context stamps its selection before hydration.
      if (typeof window === 'undefined') return undefined
      return { data: fixture() }
    }
  }
  return queryFn
}

export const getReviewFixture = (
  queryFn: unknown
): FixtureResult | undefined => {
  if (!REVIEW_FIXTURES_ENABLED || typeof window === 'undefined')
    return undefined
  return (queryFn as FixtureQuery).__tgReviewFixture?.()
}
