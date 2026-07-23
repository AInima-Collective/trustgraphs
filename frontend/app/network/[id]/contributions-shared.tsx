'use client'

import { usePonderQuery } from '@ponder/react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useMemo } from 'react'
import { Hex, erc20Abi, formatUnits } from 'viem'
import { useReadContracts } from 'wagmi'

import { contributionsQueries } from '@/lib/contributions-api'
import {
  buildClaimViews,
  contributionsSchema,
  getContributionAttestations,
} from '@/lib/contributions-view'
import { ContributionsNetwork } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * All the data the contributions screens share: the round summary (M3 indexer route), the live
 * on-chain record log (generic EAS attestation table + the parity-locked reconciliation from
 * `lib/contributions/`), and the pool token metadata.
 */
export const useContributionsData = (network: ContributionsNetwork) => {
  const claimSchema = contributionsSchema(network, 'contribution-claim')
  const responseSchema = contributionsSchema(network, 'contribution-response')
  const valuationSchema = contributionsSchema(network, 'contribution-valuation')

  const schemaUids = useMemo(
    () => ({
      claim: (claimSchema?.uid ?? '0x') as Hex,
      response: (responseSchema?.uid ?? '0x') as Hex,
      valuation: (valuationSchema?.uid ?? '0x') as Hex,
    }),
    [claimSchema?.uid, responseSchema?.uid, valuationSchema?.uid]
  )

  // Round summary from the indexer's /contributions routes. Null = not reachable/indexed yet;
  // the screens stay functional (on-chain data only) and say so honestly.
  const roundQuery = useQuery(
    contributionsQueries.round(network.contracts.merkleSnapshot)
  )
  const round = roundQuery.data ?? null

  // Live derived scores per claim (indexer recompute, asserted against the on-chain root).
  const scoresQuery = useQuery(
    contributionsQueries.claims(network.contracts.merkleSnapshot)
  )
  const scoreByUid = useMemo(() => {
    const map = new Map<string, string>()
    for (const claim of scoresQuery.data?.claims ?? []) {
      if (claim.score !== null)
        map.set(claim.claimUid.toLowerCase(), claim.score)
    }
    return map
  }, [scoresQuery.data])

  // The raw record log, straight from the chain via the generic attestation index.
  const attestationsQuery = usePonderQuery({
    queryFn: getContributionAttestations(
      network.contracts.contributionResolver,
      [schemaUids.claim, schemaUids.response, schemaUids.valuation]
    ),
    enabled:
      !!network.contracts.contributionResolver && schemaUids.claim !== '0x',
  })

  const window = useMemo(
    () =>
      round
        ? { start: BigInt(round.window.start), end: BigInt(round.window.end) }
        : undefined,
    [round]
  )

  const { claims, state } = useMemo(
    () => buildClaimViews(attestationsQuery.data ?? [], schemaUids, window),
    [attestationsQuery.data, schemaUids, window]
  )

  // Pool token metadata (TestUSDC locally; 6 decimals).
  const { data: tokenInfo } = useReadContracts({
    contracts: [
      {
        address: network.contracts.poolToken,
        abi: erc20Abi,
        functionName: 'symbol',
      },
      {
        address: network.contracts.poolToken,
        abi: erc20Abi,
        functionName: 'decimals',
      },
    ],
    query: { enabled: !!network.contracts.poolToken },
  })
  const tokenSymbol = (tokenInfo?.[0]?.result as string | undefined) ?? 'USDC'
  const tokenDecimals = (tokenInfo?.[1]?.result as number | undefined) ?? 6

  return {
    round,
    roundAvailable: !roundQuery.isLoading && round !== null,
    roundLoading: roundQuery.isLoading,
    scoreByUid,
    scoresAvailable: !scoresQuery.isLoading && scoresQuery.data !== null,
    claims,
    state,
    claimsLoading: attestationsQuery.isLoading,
    schemaUids,
    claimSchema,
    responseSchema,
    valuationSchema,
    tokenSymbol,
    tokenDecimals,
  }
}

/** Format a raw pool-token amount for display. */
export const formatPoolAmount = (
  amount: bigint | string,
  decimals: number,
  symbol: string
) =>
  `${Number(formatUnits(BigInt(amount), decimals)).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })} ${symbol}`

/** Human round status line. */
export const roundStatusLabel = (
  status: 'open' | 'closing' | 'settled' | null
): string =>
  status === 'open'
    ? 'Round open'
    : status === 'closing'
      ? 'Round closing'
      : status === 'settled'
        ? 'Round settled'
        : 'Round status unknown'

const TABS = [
  { segment: '', label: 'Round' },
  { segment: 'contribute', label: 'Contribute' },
  { segment: 'respond', label: 'Respond' },
  { segment: 'rate', label: 'Rate' },
  { segment: 'payout', label: 'Payout' },
]

/** Tab navigation across the five contributions screens. */
export const ContributionsNav = ({
  network,
}: {
  network: ContributionsNetwork
}) => {
  const pathname = usePathname()
  const base = `/network/${network.id}`

  return (
    <div className="flex flex-row items-center gap-1 flex-wrap border-b border-border pb-2">
      {TABS.map(({ segment, label }) => {
        const href = segment ? `${base}/${segment}` : base
        const active = pathname === href
        return (
          <Link
            key={label}
            href={href}
            className={cn(
              'px-3 py-1.5 text-sm rounded-sm transition-colors',
              active
                ? 'bg-primary text-primary-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            )}
          >
            {label}
          </Link>
        )
      })}
    </div>
  )
}

/** Back link to the round view. */
export const BackToRound = ({ network }: { network: ContributionsNetwork }) => (
  <Link
    href={`/network/${network.id}`}
    className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
  >
    <ArrowLeft className="w-4 h-4" />
    Back to the round
  </Link>
)
