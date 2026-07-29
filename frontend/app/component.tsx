'use client'

import { useQueries } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { Suspense, useState } from 'react'

import { ButtonLink } from '@/components/Button'
import { Markdown } from '@/components/Markdown'
import { SectionHeading } from '@/components/SectionHeading'
import { Column, Table } from '@/components/Table'
import { useNetworks } from '@/contexts/CatalogContext'
import { NetworkProvider } from '@/contexts/NetworkContext'
import { Network } from '@/lib/types'
import { cn, formatBigNumber } from '@/lib/utils'
import { ponderQueries } from '@/queries/ponder'

type NetworkRow = {
  network: Network
  memberCount: number | null
  attestationCount: number | null
  isLoading: boolean
}

// Uses web2gl, which is not supported on the server
const NetworkGraph = dynamic(
  () => import('@/components/NetworkGraph').then((mod) => mod.NetworkGraph),
  {
    ssr: false,
  }
)

export function HomePage() {
  const router = useRouter()

  // The runtime catalog (GOAL.md M3) — a network created through the factory a minute ago is in
  // here without a rebuild.
  const networks = useNetworks()
  const firstNetwork = networks[0]

  // Fetch network data for all networks in parallel
  const networkQueries = useQueries({
    queries: networks.map((network) =>
      ponderQueries.network(network.contracts.merkleSnapshot)
    ),
  })

  // Combine network config with fetched data
  const networkRows: NetworkRow[] = networks.map((network, index) => {
    const query = networkQueries[index]
    return {
      network,
      memberCount: query?.data?.accounts?.length ?? null,
      attestationCount: query?.data?.attestations?.length ?? null,
      isLoading: query?.isLoading ?? true,
    }
  })

  // Define table columns
  const columns: Column<NetworkRow>[] = [
    {
      key: 'name',
      header: 'Network',
      render: (row) => <span className="text-text">{row.network.name}</span>,
    },
    {
      key: 'members',
      header: 'Members',
      tooltip: 'The number of participants in this network with a trust score.',
      headerClassName: 'text-right',
      cellClassName: 'text-right tabular-nums text-text-muted',
      render: (row) =>
        row.isLoading
          ? '—'
          : formatBigNumber(row.memberCount ?? 0, undefined, true),
    },
    {
      key: 'attestations',
      header: 'Attestations',
      tooltip: 'The total number of attestations in this network.',
      headerClassName: 'text-right',
      cellClassName: 'text-right tabular-nums text-text-muted',
      render: (row) =>
        row.isLoading
          ? '—'
          : formatBigNumber(row.attestationCount ?? 0, undefined, true),
    },
  ]

  return (
    <div className="grid grid-cols-1 items-start justify-start gap-12 lg:grid-cols-2 lg:gap-10">
      <div className="flex flex-col items-start gap-10">
        {/* ── Hero ──────────────────────────────────────────────────────── */}
        <header className="flex flex-col items-start gap-5">
          {/* Epigraph. Pure apparatus: it names the four steps the protocol
           * actually performs, in the order it performs them. */}
          <span className="tg-marker">
            Attested · Ranked · Proven · Settled
          </span>

          <h1 className="tg-hero max-w-[15ch]">
            Networks that grow at the speed of trust
          </h1>

          <p className="max-w-prose text-text-muted">
            A trustgraph is a governance tool that makes social trust visible
            and measurable. Participants give and receive attestations: signed,
            public endorsements that build a graph. The resulting scores can be
            exported and used to inform governance decisions on external
            platforms, so legitimacy rests on relationships rather than tokens.
          </p>

          {firstNetwork && (
            <ButtonLink href={`/network/${firstNetwork.id}`} size="lg">
              View pilot network: {firstNetwork.name}
            </ButtonLink>
          )}
        </header>

        {/* ── 01 · Directory ────────────────────────────────────────────── */}
        {networks.length > 1 && (
          <section className="flex w-full flex-col gap-4">
            <SectionHeading n="01">All networks</SectionHeading>
            <Table
              columns={columns}
              data={networkRows}
              getRowKey={(row) => row.network.id}
              onRowClick={(row) => router.push(`/network/${row.network.id}`)}
              rowClickTitle="View network"
            />
          </section>
        )}

        {/* ── 02 · FAQ ──────────────────────────────────────────────────── */}
        <section className="flex w-full flex-col gap-4">
          <SectionHeading n="02">Frequently asked questions</SectionHeading>
          {/* Ruled rows rather than four separate boxes: a stack of bordered
           * cards reads as four unrelated things, a ruled list reads as one
           * set. */}
          <div className="flex flex-col items-stretch self-stretch border-b border-border">
            <FrequentlyAskedQuestion
              question="What are attestations?"
              answer="[Attestations](https://docs.attest.org/docs/core--concepts/attestations) are digital vouches: signed statements from one participant about another person, project, or claim. Each attestation adds to the collective trustgraph, shaping reputation and governance rights."
            />
            <FrequentlyAskedQuestion
              question="How does it work?"
              answer="Participants issue, receive, and revoke attestations. These build a graph of trust, analyzed through verifiable algorithms (like [PageRank](https://en.wikipedia.org/wiki/PageRank)) to generate a trust score. That score unlocks permissions such as voting, proposal submission, or role claiming in a network or funding round."
            />
            <FrequentlyAskedQuestion
              question="Why use a trustgraph?"
              answer="Because legitimacy comes from relationships, not capital. Attestations make social credibility visible, portable, and measurable, reducing sybil risk and empowering real contributors."
            />
            <FrequentlyAskedQuestion
              question="Where can I learn more?"
              answer="Explore the [open-source repository](https://github.com/JakeHartnell/ZkTrustGraph), or fill out the interest form to hear about early prototypes."
            />
          </div>
        </section>
      </div>

      {/* ── Right column ────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-8 lg:sticky lg:top-6">
        {firstNetwork && (
          <div className="flex h-[66vh] flex-col lg:h-[70vh]">
            <Suspense fallback={null}>
              <NetworkProvider network={firstNetwork}>
                <NetworkGraph
                  title={networks.length > 1 ? firstNetwork.name : undefined}
                />
              </NetworkProvider>
            </Suspense>
          </div>
        )}

        <div className="flex flex-col gap-4 border border-border p-5">
          <span className="tg-label">Pilot</span>
          <p className="text-sm text-text-muted">
            This is currently a pilot. If you are curious about how it works,
            interested in testing early prototypes, want to use it in your
            network, or just want to stay in the loop, fill out this short form.
          </p>

          <ButtonLink
            href="/interest"
            target="_blank"
            rel="noopener noreferrer"
            size="sm"
            variant="outline"
            className="self-start"
          >
            Open interest form
          </ButtonLink>
        </div>
      </div>
    </div>
  )
}

const FrequentlyAskedQuestion = ({
  question,
  answer,
}: {
  question: string
  answer: string
}) => {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setIsOpen((o) => !o)}
        aria-expanded={isOpen}
        className="flex w-full flex-row items-center justify-between gap-6 py-3.5 text-left text-sm text-text transition-colors hover:text-text-muted"
      >
        <span>{question}</span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-text-subtle transition-transform',
            isOpen ? '-rotate-180' : 'rotate-0'
          )}
        />
      </button>

      {isOpen && (
        <Markdown className="animate-in fade-in-0 pb-4 text-sm text-text-muted">
          {answer}
        </Markdown>
      )}
    </div>
  )
}
