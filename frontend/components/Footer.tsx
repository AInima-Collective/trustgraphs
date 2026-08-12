import Link from 'next/link'

import { BrandMark } from './BrandMark'
import { GitHubIcon } from './icons/GitHubIcon'
import { XIcon } from './icons/XIcon'

/**
 * The footer earns its rule by carrying something: the mark, the colophon, and
 * the outbound links. Previously it was a bare hairline with two icons pinned
 * to the right, which read as an accident.
 *
 * The link row is FAQ · Docs · GitHub · X, per the copy doc. FAQ leads because
 * the questions page is the only place the caveats live, so the footer is the
 * sitewide route to them.
 *
 * Every link is a 44px box. The two icons look like 16px glyphs and behave like
 * proper targets; the negative margins keep the row the height it was drawn at
 * instead of letting the tap targets inflate the rule spacing.
 */

// `min-w-11` is the same trick as `Nav.tsx`: it buys the 44px floor by growing
// the box to the RIGHT, so the ink stays where it was. Without it, "FAQ" is
// short enough that `px-2` leaves the target 37px wide below `sm` — a three-
// letter word was the only thing setting the width. There is 131px of unused
// room on that row at 320px, so nothing is being squeezed to afford it.
const LINK =
  'inline-flex h-11 min-w-11 items-center justify-center transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink'

const ICON_LINK = `${LINK} w-11`

export const Footer = () => {
  return (
    <footer className="mt-12 flex flex-col gap-1 border-t border-border py-2 text-xs text-text-subtle sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-h-11 items-center gap-2.5">
        <BrandMark size="xs" className="text-text-subtle" />
        {/* Tracked, not uppercased. The brand has exactly two cases:
         * `trustgraphs` in copy and `Trustgraphs` in the wordmark and titles.
         * This sits directly next to the mark, so it is the wordmark lockup,
         * not prose — it takes the capitalized case. */}
        <span className="tracking-wider">Trustgraphs</span>
        <span aria-hidden="true">·</span>
        <span>Trust, made legible</span>
      </div>

      <div className="-ml-2 flex flex-row items-center gap-1 sm:-mr-3.5 sm:ml-0">
        {/* No prefetch. The footer is on every page including /faq itself,
         * where the default prefetch made the page fetch 77.5 KB of its own RSC
         * payload after load. A one-line footer link does not need to be warm. */}
        <Link href="/faq" prefetch={false} className={`${LINK} px-2 sm:px-3`}>
          FAQ
        </Link>
        <Link href="/docs" prefetch={false} className={`${LINK} px-2 sm:px-3`}>
          Docs
        </Link>
        <a
          href="https://github.com/JakeHartnell/trustgraphs"
          target="_blank"
          rel="noopener noreferrer"
          className={ICON_LINK}
          aria-label="GitHub"
        >
          <GitHubIcon className="h-4 w-4" />
        </a>
        <a
          href="https://x.com/trustgraphs"
          target="_blank"
          rel="noopener noreferrer"
          className={ICON_LINK}
          aria-label="X"
        >
          <XIcon className="h-3.5 w-4" />
        </a>
      </div>
    </footer>
  )
}
