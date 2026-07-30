'use client'

import Link from 'next/link'

import { WalletConnectionButton } from '@/components/WalletConnectionButton'

import { BrandMark } from './BrandMark'
import { ButtonLink } from './Button'
import { ThemeToggle } from './ThemeToggle'

/**
 * The nav is a single hairline with things sitting on it. No fill, no
 * elevation, no pill — the rule under it is the only chrome, and it is the
 * same rule that separates every other section on the page.
 *
 * TWO LINKS THAT MUST NOT BE CONFUSED. `Networks` goes to the directory,
 * `Create a network` starts one, and they now sit side by side. The create
 * control used to render "Create a&nbsp;" + "Network", which gave a phone the
 * word "NETWORK" on its own (meaningless next to "NETWORKS") and gave a desktop
 * a hard space that mono tracking stretched into a gap wide enough to read as
 * two separate links. It is one label now, shortened to the verb on small
 * screens: "CREATE" can only be one thing.
 *
 * FITTING 320px. Five things is more than a 320px viewport holds at full size,
 * so below `xs` (410px) the wordmark drops and the mark carries the brand on
 * its own — the home link keeps its accessible name either way. That is the
 * only element here that is decoration rather than a destination.
 */
export const Nav = () => {
  return (
    <nav
      aria-label="Main"
      className="flex flex-row items-center justify-between border-b border-border pb-3 sm:pb-4"
    >
      <Link
        href="/"
        className="flex h-11 shrink-0 items-center gap-2.5 transition-opacity hover:opacity-70"
        aria-label="Trustgraphs, home"
      >
        <BrandMark size="md" className="text-text" />
        <span className="hidden text-base tracking-tight text-text xs:inline">
          Trustgraphs
        </span>
      </Link>

      {/* `h-11` overrides the button's default `h-9`. Every control on this row
       * is a touch target on a phone, and 36px is under the 44px floor this
       * program is gated on. tailwind-merge resolves the conflict in favour of
       * the class passed here. */}
      <div className="flex flex-row items-center gap-1 md:gap-2">
        <ButtonLink
          href="/networks"
          variant="ghost"
          className="h-11 px-2 md:px-4"
        >
          Networks
        </ButtonLink>

        <ButtonLink
          href="/create"
          variant="ghost"
          className="h-11 px-2 md:px-4"
        >
          <span className="sm:hidden">Create</span>
          <span className="hidden sm:inline">Create a network</span>
        </ButtonLink>

        <WalletConnectionButton />

        <ThemeToggle />
      </div>
    </nav>
  )
}
