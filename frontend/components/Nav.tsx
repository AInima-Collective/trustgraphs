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
      className="flex flex-row items-center justify-between border-b border-border pb-3 sm:pb-4 [@media(max-height:480px)]:pb-2"
    >
      <Link
        href="/"
        prefetch={false}
        // `justify-start` at every width. `min-w-11` buys the 44px tap target
        // by extending the box to the RIGHT; centring the mark inside it instead
        // pushed the 24px mark 10px in from the frame, so below 410px the same
        // mark sat at x=18 in the nav and x=8 in the footer, on one screen, with
        // the eyebrow and the h1 on the footer's edge.
        className="flex h-11 min-w-11 shrink-0 items-center justify-start gap-2.5 transition-opacity hover:opacity-70 xs:min-w-0"
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
       * the class passed here.
       *
       * `prefetch={false}` ON ALL OF THEM, and this is the second time the same
       * mechanism has been caught. `Footer.tsx` already turns it off on its /faq
       * link, with a comment naming exactly this; the nav was left at the
       * default, which quietly undid the payload work: measured on the shipped
       * build, `/faq` pulled 581 KB it did not need within two seconds of load,
       * `/networks` about 633 KB. That is not RSC payload, it is the chunks the
       * three prefetched routes reference — including the 1.1 MB EAS SDK and
       * ethers bundle and the markdown/animation pair that were deliberately
       * split off the marketing routes one round earlier.
       *
       * The trade is a fetch on click instead of before it. On a static page
       * whose whole argument is that it is cheap to read, that is the right way
       * round: nobody arriving at the questions page has asked for the create
       * wizard. */}
      <div className="flex flex-row items-center gap-1 md:gap-2">
        <ButtonLink
          href="/networks"
          variant="ghost"
          prefetch={false}
          className="h-11 px-2 md:px-4"
        >
          Networks
        </ButtonLink>

        <ButtonLink
          href="/create"
          variant="ghost"
          prefetch={false}
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
