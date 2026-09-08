'use client'

import Link from 'next/link'
import { useState } from 'react'

import { WalletConnectionButton } from '@/components/WalletConnectionButton'
import { cn } from '@/lib/utils'

import { BrandMark } from './BrandMark'
import { ButtonLink } from './Button'
import { MobileMenu, MobileMenuScrim } from './MobileMenu'
import { ThemeToggle } from './ThemeToggle'

/**
 * The nav is drawn with hairlines. No fill, no elevation, no pill — the rules
 * are the same separators used by every other section on the page.
 *
 * TWO LINKS THAT MUST NOT BE CONFUSED. `Networks` goes to the directory,
 * `Create a network` starts one. From `md` up they sit on the single hairline
 * next to the wallet and theme controls. On a phone the row is the wordmark,
 * the wallet button and a menu button, and the two destinations (with the
 * theme toggle, and the reading routes) unfold from under the rule when the
 * menu opens: see `MobileMenu.tsx`. One row at every width, and the wordmark
 * stays whole down to 320px.
 *
 * THE NAV RAISES ITSELF WHILE THE MENU IS OPEN. The scrim is a fixed layer
 * inside the nav and the row is a positioned layer above it; the nav becomes
 * a stacking context at `z-50` only while the menu is open, so the scrim
 * covers the page and nothing else on the page is affected the rest of the
 * time. The row carries the bottom padding rather than the nav, because the
 * sheet hangs from the row's padding edge and that edge is the rule.
 */
export const Nav = () => {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <nav
      aria-label="Main"
      className={cn('relative border-b border-border', menuOpen && 'z-50')}
    >
      <MobileMenuScrim open={menuOpen} onClose={() => setMenuOpen(false)} />

      {/* `bg-background` is for the open menu: the scrim sits under this row,
       * and without a fill of its own the row would be the one dimmed thing
       * above the lit sheet. */}
      <div className="relative z-20 flex flex-row items-center bg-background pb-2 md:pb-4 md:[@media(max-height:480px)]:pb-2">
        <Link
          href="/"
          prefetch={false}
          // `min-w-0` so the wordmark can truncate rather than push the
          // controls off the right edge at 320px.
          // The focus treatment is spelled out because leaving it off does not
          // mean "inherit the app's ring", it means Chromium paints its own.
          // The global fallback resolves to `outline-style: auto`, and `auto`
          // makes the platform draw a two-tone ring and DISCARD the declared
          // outline-color, so the design system's own token never reached the
          // pixels on the first tab stop of every page: 1px at 1px offset,
          // measured 1.06:1 against the page in light theme, where the other
          // twenty-seven stops carry 2px at 2px offset and measure 18.40:1.
          className="flex h-11 min-w-0 items-center justify-start gap-2.5 transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          aria-label="Trustgraphs, home"
        >
          <BrandMark size="md" className="text-text" />
          <span className="truncate text-base tracking-tight text-text">
            Trustgraphs
          </span>
        </Link>

        {/* `h-11` overrides the button's default `h-9`. Every control in the
         * nav is a touch target on a tablet, and 36px is under the 44px floor
         * this program is gated on. tailwind-merge resolves the conflict in
         * favour of the class passed here.
         *
         * `prefetch={false}` ON ALL OF THEM, and this is the second time the
         * same mechanism has been caught. `Footer.tsx` already turns it off on
         * its /faq link, with a comment naming exactly this; the nav was left
         * at the default, which quietly undid the payload work: measured on
         * the shipped build, `/faq` pulled 581 KB it did not need within two
         * seconds of load, `/networks` about 633 KB. That is not RSC payload,
         * it is the chunks the three prefetched routes reference — including
         * the 1.1 MB EAS SDK and ethers bundle and the markdown/animation pair
         * that were deliberately split off the marketing routes one round
         * earlier.
         *
         * The trade is a fetch on click instead of before it. On a static page
         * whose whole argument is that it is cheap to read, that is the right
         * way round: nobody arriving at the questions page has asked for the
         * create wizard. */}
        <div className="ml-auto hidden md:flex md:gap-2">
          <ButtonLink
            href="/networks"
            variant="ghost"
            prefetch={false}
            className="h-11 px-4"
          >
            Networks
          </ButtonLink>

          <ButtonLink
            href="/create"
            variant="ghost"
            prefetch={false}
            className="h-11 px-4"
          >
            Create a network
          </ButtonLink>
        </div>

        <div className="ml-auto flex flex-row items-center gap-1 md:ml-2 md:gap-2">
          <WalletConnectionButton />

          <ThemeToggle className="hidden md:inline-flex" />

          <MobileMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            className="md:hidden"
          />
        </div>
      </div>
    </nav>
  )
}
