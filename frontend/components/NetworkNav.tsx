'use client'

import {
  ArrowUpRight,
  HandCoins,
  LayoutDashboard,
  Settings,
  Vote,
  WalletCards,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'

import { NetworkTab } from '@/lib/network-nav'
import { cn } from '@/lib/utils'

/**
 * The tab bar every network sub-page shares. Rendered by the trust-graph and contributions
 * screens alike so a network's features stay reachable once you have navigated into one of them.
 * Feature icons are defined by the tab model, keeping them consistent on every screen.
 *
 * Scrolls horizontally rather than wrapping: a network with several sibling rounds would
 * otherwise push the page heading down a line on a phone.
 */
export const NetworkNav = ({
  tabs,
  className,
}: {
  tabs: NetworkTab[]
  className?: string
}) => {
  const pathname = usePathname()
  const navRef = useRef<HTMLElement>(null)

  // A phone can only show part of a feature-rich network's tab row. Keep the
  // current destination in view after direct navigation instead of making the
  // active state exist just beyond the right edge of the screen.
  useEffect(() => {
    navRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [pathname])

  // Nothing to navigate to: an instance with no gov module, no distributor and no sibling round
  // has only its overview, and a lone "Overview" tab is noise.
  if (tabs.length < 2) return null

  const pages = tabs.filter((tab) => !tab.crossInstance)
  const related = tabs.filter((tab) => tab.crossInstance)

  const icons = {
    overview: LayoutDashboard,
    governance: Vote,
    contributions: HandCoins,
    rewards: WalletCards,
    settings: Settings,
  }

  const renderTab = (tab: NetworkTab) => {
    const active = tab.exact
      ? pathname === tab.href
      : pathname === tab.href || pathname.startsWith(`${tab.href}/`)
    const Icon = tab.icon ? icons[tab.icon] : null

    return (
      <Link
        key={tab.href}
        href={tab.href}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-sm transition-colors',
          active
            ? 'bg-primary text-primary-foreground font-medium'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent'
        )}
      >
        {Icon && <Icon className="w-4 h-4" />}
        {tab.label}
        {tab.crossInstance && <ArrowUpRight className="w-3.5 h-3.5" />}
      </Link>
    )
  }

  return (
    <nav
      ref={navRef}
      aria-label="Network sections"
      className={cn(
        'flex flex-row items-center gap-1 border-b border-border pb-2 overflow-x-auto',
        className
      )}
    >
      {pages.map(renderTab)}

      {related.length > 0 && (
        <span
          aria-hidden
          className="shrink-0 mx-2 h-4 w-px bg-border self-center"
        />
      )}

      {related.map(renderTab)}
    </nav>
  )
}
