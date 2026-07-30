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

const LINK =
  'inline-flex h-11 items-center transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

const ICON_LINK = `${LINK} w-11 justify-center`

export const Footer = () => {
  return (
    <footer className="mt-12 flex flex-col gap-1 border-t border-border py-2 text-xs text-text-subtle sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-h-11 items-center gap-2.5">
        <BrandMark size="xs" className="text-text-subtle" />
        <span className="tracking-wider uppercase">trustgraphs</span>
        <span aria-hidden="true">·</span>
        <span>Trust, made legible</span>
      </div>

      <div className="-ml-3 flex flex-row items-center gap-1 sm:-mr-3.5 sm:ml-0">
        <Link href="/faq" className={`${LINK} px-3`}>
          FAQ
        </Link>
        <a
          href="https://github.com/JakeHartnell/ZkTrustGraph/tree/main/docs"
          target="_blank"
          rel="noopener noreferrer"
          className={`${LINK} px-3`}
        >
          Docs
        </a>
        <a
          href="https://github.com/JakeHartnell/ZkTrustGraph"
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
          aria-label="X (Twitter)"
        >
          <XIcon className="h-3.5 w-4" />
        </a>
      </div>
    </footer>
  )
}
