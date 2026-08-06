'use client'

import { Link as LinkIcon } from 'lucide-react'

import { NetworkNav } from '@/components/NetworkNav'
import { NetworkTab, trustGraphTabs } from '@/lib/network-nav'
import { ContributionsNetwork, Network } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * The one header every network screen shares: network name, its outbound
 * link, the tab bar. Byte-identical across a network's tabs so switching
 * tabs reads as switching tabs, not as landing on a different page.
 * Page-specific copy belongs below this, in the content.
 */
export function NetworkHeader({
  network,
  tabs,
  className,
}: {
  network: Network | ContributionsNetwork
  /**
   * Defaults to the trust-graph tab set. Contributions screens pass
   * `contributionsTabs(round)`; a ContributionsNetwork without explicit tabs
   * is a caller bug.
   */
  tabs?: NetworkTab[]
  className?: string
}) {
  const { name, link } = network

  return (
    <div className={cn('flex flex-col items-start gap-4', className)}>
      <h1 className="text-4xl font-bold">{name}</h1>

      {link && (
        <p className="text-sm flex flex-row items-center gap-2 flex-wrap">
          {link.prefix && <span>{link.prefix}</span>}
          <a
            className="inline-flex flex-row items-center gap-1.5 text-text underline underline-offset-4 transition-colors hover:text-text-muted"
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            <LinkIcon className="w-4 h-4" />
            <span>{link.label}</span>
          </a>
        </p>
      )}

      <NetworkNav
        tabs={tabs ?? trustGraphTabs(network as Network)}
        className="w-full mt-2"
      />
    </div>
  )
}
