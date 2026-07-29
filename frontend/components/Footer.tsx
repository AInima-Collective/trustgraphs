import { BrandMark } from './BrandMark'
import { GitHubIcon } from './icons/GitHubIcon'
import { XIcon } from './icons/XIcon'

/**
 * The footer earns its rule by carrying something: the mark, the colophon, and
 * the two outbound links. Previously it was a bare hairline with two icons
 * pinned to the right, which read as an accident.
 */
export const Footer = () => {
  return (
    <footer className="mt-12 flex flex-col gap-3 border-t border-border py-5 text-xs text-text-subtle sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2.5">
        <BrandMark size="xs" className="text-text-subtle" />
        <span className="uppercase tracking-wider">trustgraphs</span>
        <span aria-hidden="true">·</span>
        <span>Trust, made legible</span>
      </div>

      <div className="flex flex-row items-center gap-3">
        <a
          href="https://x.com/trustgraphs"
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-text"
          aria-label="X (Twitter)"
        >
          <XIcon className="h-3.5 w-4" />
        </a>
        <a
          href="https://github.com/JakeHartnell/ZkTrustGraph"
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-text"
          aria-label="GitHub"
        >
          <GitHubIcon className="h-4 w-4" />
        </a>
      </div>
    </footer>
  )
}
