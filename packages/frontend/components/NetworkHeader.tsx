'use client'

import { Link as LinkIcon } from 'lucide-react'

import { Markdown } from '@/components/Markdown'
import { NetworkNav } from '@/components/NetworkNav'
import { useContributionsRounds } from '@/hooks/useContributionsRounds'
import { contributionsRoundsFor, NetworkTab, trustgraphsTabs } from '@/lib/network-nav'
import { ContributionsNetwork, Network } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * The one header every network screen shares: network name, its outbound
 * link, and the tab bar. Overview screens may add the network description;
 * sub-pages keep the same identity and navigation in a more compact form.
 */
export function NetworkHeader({
  network,
  tabs,
  description,
  className,
}: {
  network: Network | ContributionsNetwork
  /**
   * Defaults to the trust-graph tab set. Contributions screens pass
   * `contributionsTabs(round)`; a ContributionsNetwork without explicit tabs
   * is a caller bug.
   */
  tabs?: NetworkTab[]
  /**
   * Overview copy belongs with the network identity when it is the context for
   * the whole page. Sub-pages omit it so their shared header stays compact.
   */
  description?: string
  className?: string
}) {
  const { name, link } = network

  // Default (trust-graph) tab set: the Contributions tab is gated on the network actually having
  // rounds, which live in the indexer's runtime round catalog — resolved here so every screen
  // that shares this header agrees. Skipped entirely when the caller passed explicit tabs.
  const trustNetwork = tabs ? undefined : (network as Network)
  const { rounds } = useContributionsRounds(trustNetwork?.instanceId)

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

      {description && (
        <Markdown className="max-w-[80ch] gap-2 text-sm leading-relaxed text-text-muted">
          {description}
        </Markdown>
      )}

      <NetworkNav
        tabs={
          tabs ??
          trustgraphsTabs(
            network as Network,
            contributionsRoundsFor(network as Network, rounds)
          )
        }
        className="w-full mt-2"
      />
    </div>
  )
}
