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
 */
export const Nav = () => {
  return (
    <nav className="flex flex-row items-center justify-between border-b border-border pb-3 sm:pb-4">
      <Link
        href="/"
        className="flex items-center gap-2.5 transition-opacity hover:opacity-70"
        aria-label="Trustgraphs, home"
      >
        <BrandMark size="md" className="text-text" />
        <span className="text-base tracking-tight text-text">Trustgraphs</span>
      </Link>

      <div className="flex flex-row items-center gap-2">
        <ButtonLink href="/create" variant="ghost">
          <span className="hidden sm:inline">Create a&nbsp;</span>
          Network
        </ButtonLink>

        <WalletConnectionButton />

        <ThemeToggle />
      </div>
    </nav>
  )
}
