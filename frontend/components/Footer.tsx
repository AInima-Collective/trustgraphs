import { GitHubIcon } from './icons/GitHubIcon'
import { XIcon } from './icons/XIcon'

export const Footer = () => {
  return (
    <footer className="mt-8 py-4 sm:pb-0 border-t border-border/40 flex flex-row justify-end items-center text-xs text-muted-foreground">
      <div className="flex flex-row items-center gap-3">
        <a
          href="https://x.com/TrustGraphNet"
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-foreground"
          aria-label="X (Twitter)"
        >
          <XIcon className="w-4 h-3.5" />
        </a>
        <a
          href="https://github.com/Lay3rLabs/TrustGraph"
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-foreground"
          aria-label="GitHub"
        >
          <GitHubIcon className="w-4 h-4" />
        </a>
      </div>
    </footer>
  )
}
