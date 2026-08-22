/**
 * The repository's star count, for the landing page's open-source CTA.
 *
 * Server-only. The count is social proof attached to a "Star on GitHub"
 * button, which means two things follow:
 *
 * 1. It must never take the page down. GitHub's unauthenticated API is rate
 *    limited per IP (60/hour), and a marketing page that 500s because a third
 *    party throttled the build is a bad trade for a number. Every failure —
 *    non-OK, timeout, malformed body, no network at all — degrades to `null`,
 *    and the button renders exactly as it did before this file existed.
 * 2. It must only appear when it argues FOR the button. See `MIN_STARS_SHOWN`.
 */

const STARS_REVALIDATE_SECONDS = 3_600

/**
 * GitHub is a third party on the render path, so it gets a short leash. Next's
 * fetch has no timeout of its own; without this, an API that accepts the
 * connection and stops talking holds the render open until the platform's
 * limit. Same reasoning as `SUMMARY_TIMEOUT_MS` in directory.server.ts.
 */
const STARS_TIMEOUT_MS = 2_500

/**
 * Below this, the count argues against the CTA it is meant to strengthen.
 *
 * Social proof is a threshold effect: "★ 2,400" earns a click, "★ 3" tells a
 * visitor nobody is here and makes the button weaker than a button with no
 * number at all. So the count is wired up and refreshed hourly, and it starts
 * showing itself the moment the repository clears this bar. Lower it to 0 to
 * always show the number.
 */
export const MIN_STARS_SHOWN = 25

/** `owner/repo`, matching REPO_URL on the landing page. */
const REPO = 'JakeHartnell/trustgraphs'

/**
 * The star count, or `null` when it cannot be read. Never throws.
 */
export const getRepoStars = async (): Promise<number | null> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), STARS_TIMEOUT_MS)
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}`, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
      next: { revalidate: STARS_REVALIDATE_SECONDS },
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    const count =
      typeof body === 'object' && body !== null
        ? (body as { stargazers_count?: unknown }).stargazers_count
        : undefined
    return typeof count === 'number' && Number.isFinite(count) && count >= 0
      ? count
      : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `2400` → `2.4k`. The button is a fixed-width element in a narrow column, so
 * the number cannot be allowed to grow without bound.
 */
export const formatStars = (count: number): string =>
  count >= 1_000
    ? `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}k`
    : `${count}`
