'use client'

import Link from 'next/link'

import { WalletConnectionButton } from '@/components/WalletConnectionButton'

import { BrandMark } from './BrandMark'
import { ButtonLink } from './Button'
import { ThemeToggle } from './ThemeToggle'

/**
 * The nav is drawn with hairlines. No fill, no elevation, no pill — the rules
 * are the same separators used by every other section on the page.
 *
 * TWO LINKS THAT MUST NOT BE CONFUSED. `Networks` goes to the directory,
 * `Create a network` starts one. On a phone they get their own full-width row:
 * that leaves the wordmark intact, keeps both destinations available, and
 * gives another primary destination somewhere honest to go in future. At `md`
 * the same elements return to the single hairline used on wider screens; the
 * extra tablet-width runway also survives longer translated labels.
 */
export const Nav = () => {
  return (
    <nav
      aria-label="Main"
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center border-b border-border md:flex md:flex-row md:pb-4 md:[@media(max-height:480px)]:pb-2"
    >
      <Link
        href="/"
        prefetch={false}
        // `justify-start` at every width. The brand owns the flexible mobile
        // column, while the wallet and theme controls keep their fixed targets.
        // This is why the wordmark can stay visible even at 320px.
        // The focus treatment is spelled out because leaving it off does not
        // mean "inherit the app's ring", it means Chromium paints its own.
        // The global fallback resolves to `outline-style: auto`, and `auto`
        // makes the platform draw a two-tone ring and DISCARD the declared
        // outline-color, so the design system's own token never reached the
        // pixels on the first tab stop of every page: 1px at 1px offset,
        // measured 1.06:1 against the page in light theme, where the other
        // twenty-seven stops carry 2px at 2px offset and measure 18.40:1.
        className="order-1 flex h-11 min-w-0 items-center justify-start gap-2.5 transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        aria-label="Trustgraphs, home"
      >
        <BrandMark size="md" className="text-text" />
        <span className="truncate text-base tracking-tight text-text">
          Trustgraphs
        </span>
      </Link>

      {/* `h-11` overrides the button's default `h-9`. Every control in the nav
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
      <div className="relative order-3 col-span-2 grid grid-cols-2 border-t border-border before:absolute before:inset-y-0 before:left-1/2 before:w-px before:bg-border md:order-2 md:ml-auto md:flex md:gap-2 md:border-t-0 md:before:hidden">
        <ButtonLink
          href="/networks"
          variant="ghost"
          prefetch={false}
          className="h-11 w-full px-2 md:w-auto md:px-4"
        >
          Networks
        </ButtonLink>

        <ButtonLink
          href="/create"
          variant="ghost"
          prefetch={false}
          className="h-11 w-full px-2 md:w-auto md:px-4"
        >
          <span className="sm:hidden">Create</span>
          <span className="hidden sm:inline">Create a network</span>
        </ButtonLink>
      </div>

      <div className="order-2 flex flex-row items-center gap-1 md:order-3 md:ml-2 md:gap-2">
        <WalletConnectionButton />

        <ThemeToggle />
      </div>
    </nav>
  )
}
