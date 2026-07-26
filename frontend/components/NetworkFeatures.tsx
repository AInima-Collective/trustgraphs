'use client'

import { usePonderQuery } from '@ponder/react'
import { ArrowRight, Coins, HandCoins, Vote } from 'lucide-react'
import Link from 'next/link'
import { ReactNode } from 'react'
import { Hex, formatEther } from 'viem'
import { useBalance } from 'wagmi'

import { Card } from '@/components/Card'
import { SectionHeading } from '@/components/SectionHeading'
import { useNetwork } from '@/contexts/NetworkContext'
import { contributionsRoundsFor } from '@/lib/network-nav'
import { cn } from '@/lib/utils'
import { ponderQueryFns } from '@/queries/ponder'

/**
 * One destination, explained. The stat line is the point: a card that only names a feature makes
 * you open it to find out whether anything is there, which is the problem this section exists to
 * solve.
 */
const FeatureCard = ({
  href,
  icon,
  title,
  description,
  stat,
}: {
  href: string
  icon: ReactNode
  title: string
  description: string
  stat: ReactNode
}) => (
  <Link href={href} className="block group">
    <Card
      type="outline"
      size="lg"
      className={cn(
        'h-full flex flex-col gap-3 transition-colors',
        'group-hover:border-foreground/40 group-hover:bg-accent/40'
      )}
    >
      <div className="flex flex-row items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <h3 className="font-bold">{title}</h3>
      </div>

      <p className="text-sm text-muted-foreground flex-1">{description}</p>

      <div className="flex flex-row items-center justify-between gap-4">
        <span className="text-sm font-medium">{stat}</span>
        <ArrowRight className="w-4 h-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>
    </Card>
  </Link>
)

/**
 * "What you can do here" for a trust-graph network: every feature this instance actually has,
 * with a live count so the card says whether it is in use before you click it.
 *
 * Gated on the same contracts as the tab bar (`lib/network-nav.ts`) — a factory-minted network
 * with no gov module and no distributor renders nothing at all rather than dead links.
 */
export const NetworkFeatures = () => {
  const { network } = useNetwork()
  const base = `/network/${network.id}`

  const govModule = network.contracts.merkleGovModule
  const distributor = network.contracts.merkleFundDistributor
  const rounds = contributionsRoundsFor(network)

  const { data: moduleState } = usePonderQuery({
    queryFn: ponderQueryFns.getGovModule((govModule ?? '') as Hex),
    enabled: !!govModule,
  })

  // The Safe the module executes against, which is where the treasury actually sits.
  const { data: treasury } = useBalance({
    address: moduleState?.target,
    query: { enabled: !!moduleState?.target },
  })

  const { data: distributions } = usePonderQuery({
    queryFn: ponderQueryFns.getFundDistributions((distributor ?? '') as Hex),
    enabled: !!distributor,
  })

  if (!govModule && !distributor && rounds.length === 0) return null

  const plural = (count: number, noun: string) =>
    `${count} ${noun}${count === 1 ? '' : 's'}`

  return (
    <div className="space-y-6">
      <SectionHeading>What you can do here</SectionHeading>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {govModule && (
          <FeatureCard
            href={`${base}/governance`}
            icon={<Vote className="w-4 h-4" />}
            title="Governance"
            description="Propose and vote on what this network's Safe should do. Your vote weight is your trust score at the proposal's snapshot."
            stat={
              moduleState
                ? `${plural(Number(moduleState.proposalCount), 'proposal')}${
                    treasury
                      ? ` · ${Number(
                          formatEther(treasury.value)
                        ).toLocaleString(undefined, {
                          maximumFractionDigits: 4,
                        })} ${treasury.symbol} in the treasury`
                      : ''
                  }`
                : 'Loading...'
            }
          />
        )}

        {distributor && (
          <FeatureCard
            href={`${base}/distribute`}
            icon={<Coins className="w-4 h-4" />}
            title="Distribute funds"
            description="Fund a pool and split it across members by trust score. Each member then claims their own share."
            stat={
              distributions
                ? distributions.length === 0
                  ? 'No distributions yet'
                  : plural(distributions.length, 'distribution')
                : 'Loading...'
            }
          />
        )}

        {rounds.map((round) => (
          <FeatureCard
            key={round.id}
            href={`/network/${round.id}`}
            icon={<HandCoins className="w-4 h-4" />}
            title={round.name}
            description="A funding round that scores contributions using this network's trust graph: claim work, respond to being named, and rate what others did."
            stat="Open the round"
          />
        ))}
      </div>
    </div>
  )
}
