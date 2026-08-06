'use client'

import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { useMemo } from 'react'
import { Hex, erc20Abi } from 'viem'
import { useReadContracts } from 'wagmi'

import {
  ContributionsRound,
  contributionsQueries,
} from '@/lib/contributions-api'
import {
  accumulatorRowsToRawEdges,
  buildClaimViews,
  contributionsSchema,
  getContributionAttestations,
  getTrustAttestations,
} from '@/lib/contributions-view'
import { ContributionsNetwork } from '@/lib/types'
import { usePonderQuery } from '@/lib/use-ponder-query'
import { ponderQueryFns } from '@/queries/ponder'

export type RoundPhase =
  | 'upcoming'
  | 'open'
  | 'settling'
  | 'claimable'
  | 'unknown'

type RootRecord = { root: string }

/**
 * The one lifecycle derivation for every contributions surface.
 *
 * A distribution only makes the closed round claimable when it is pinned to the current proven
 * root. An older distribution is history, not evidence that the latest scores are ready. When
 * the round API is unreachable we deliberately return `unknown`: on-chain roots and
 * distributions keep rendering, but they cannot tell us whether the submission window is open.
 */
export const roundPhase = ({
  round,
  distributions,
  latestSnapshot,
}: {
  round: ContributionsRound | null
  distributions: readonly RootRecord[]
  latestSnapshot?: RootRecord | null
}): RoundPhase => {
  if (!round || round.status === 'unknown') return 'unknown'
  if (round.status === 'upcoming') return 'upcoming'
  if (round.status === 'open') return 'open'

  const currentRoot = round.root ?? latestSnapshot?.root ?? null
  if (!currentRoot) return 'settling'
  const normalizedRoot = currentRoot.toLowerCase()
  return distributions.some(
    (distribution) => distribution.root.toLowerCase() === normalizedRoot
  )
    ? 'claimable'
    : 'settling'
}

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

  const { claims, state, records } = useMemo(
    () => buildClaimViews(attestationsQuery.data ?? [], schemaUids, window),
    [attestationsQuery.data, schemaUids, window]
  )

  const trustAttestationsQuery = usePonderQuery({
    queryFn: getTrustAttestations(network.contracts.trustAccumulator),
    enabled: !!network.contracts.trustAccumulator,
  })
  const trustEdges = useMemo(
    () => accumulatorRowsToRawEdges(trustAttestationsQuery.data ?? []),
    [trustAttestationsQuery.data]
  )

  // Payout state is part of the shared phase model. These remain on-chain when the round API is
  // unavailable, even though the phase honestly becomes unknown without the window status.
  const { data: distributions = [] } = usePonderQuery({
    queryFn: ponderQueryFns.getFundDistributions(
      network.contracts.merkleFundDistributor
    ),
    enabled: !!network.contracts.merkleFundDistributor,
  })
  const { data: latestSnapshot } = usePonderQuery({
    queryFn: ponderQueryFns.getLatestMerkleSnapshot(
      network.contracts.merkleSnapshot
    ),
    enabled: !!network.contracts.merkleSnapshot,
  })

  const phase = roundPhase({ round, distributions, latestSnapshot })

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
    distributions,
    latestSnapshot,
    phase,
    claims,
    state,
    records,
    trustEdges,
    trustEdgesLoading: trustAttestationsQuery.isLoading,
    trustEdgesAvailable:
      !trustAttestationsQuery.isLoading && trustEdges.length > 0,
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
) => {
  const raw = BigInt(amount)
  const visibleDecimals = Math.min(Math.max(decimals, 0), 2)
  const discardedDecimals = Math.max(decimals - visibleDecimals, 0)
  const roundingScale = 10n ** BigInt(discardedDecimals)
  const rounded =
    discardedDecimals === 0 ? raw : (raw + roundingScale / 2n) / roundingScale
  const visibleScale = 10n ** BigInt(visibleDecimals)
  const whole = rounded / visibleScale
  const fraction = rounded % visibleScale
  const fractionLabel =
    visibleDecimals > 0
      ? `.${fraction
          .toString()
          .padStart(visibleDecimals, '0')
          .replace(/0+$/, '')}`
      : ''
  return `${whole.toLocaleString()}${fractionLabel.replace(/\.$/, '')} ${symbol}`
}

/** Format a proof-produced 1e18 score without converting it through a floating-point number. */
export const formatContributionScore = (score: string) => {
  const displayScale = 1_000n
  const sourceScale = 10n ** 18n
  const raw = BigInt(score)
  const rounded = (raw * displayScale + sourceScale / 2n) / sourceScale
  const whole = rounded / displayScale
  const fraction = (rounded % displayScale)
    .toString()
    .padStart(3, '0')
    .replace(/0+$/, '')
  return fraction
    ? `${whole.toLocaleString()}.${fraction}`
    : whole.toLocaleString()
}

/**
 * Contributions routes intentionally have no local tab row. Kept temporarily while the legacy
 * route components still import it; M5 removes those routes entirely.
 */
export const ContributionsNav = (_props: { network: ContributionsNetwork }) =>
  null

/** Back link to the round view. */
export const BackToRound = ({ network }: { network: ContributionsNetwork }) => (
  <Link
    href={`/networks/${network.id}`}
    className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
  >
    <ArrowLeft className="w-4 h-4" />
    Back to the round
  </Link>
)
