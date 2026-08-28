//! What a network instance can actually DO, as a navigable list.
//!
//! One place decides which sub-pages exist for a given instance, so every page presents the same
//! navigation and any future entry point can reuse it.
//!
//! Tabs are CONTRACT-GATED, not hard-coded. A network minted by `TrustgraphsFactory` has no Safe
//! gov module and no fund distributor until someone deploys them, so offering those tabs would
//! route people to a page that can only tell them the feature does not exist here.

import type { CompositionInstance } from './composition/api'
import { ContributionsNetwork, Network } from './types'
import { isHexEqual } from './utils'

export type NetworkTab = {
  href: string
  label: string
  icon?: 'overview' | 'governance' | 'contributions' | 'rewards' | 'settings'
  /**
   * Match the pathname exactly rather than by prefix. Set on a tab whose href is a prefix of its
   * siblings' (the overview `/networks/[id]`), which would otherwise read as active everywhere.
   */
  exact?: boolean
  /**
   * This tab leaves the current instance for a related one. Rendered after a separator with an
   * arrow, because "another program scored against this network" is a different kind of
   * destination than "another page of this network" and pretending otherwise misleads.
   */
  crossInstance?: boolean
}

/**
 * The contribution rounds scored against THIS trust network, from a runtime rounds list
 * (the indexer's `/contributions/instances` catalog — `lib/contributions-catalog.ts` /
 * `useContributionsRounds`).
 *
 * The link is the factory's first-class parent reference: a round's `parentInstanceId` is the
 * trust network's registry instance id, recorded at creation. Address equality against the
 * parent's accumulator is deliberately NOT used any more — two networks can wrap the same
 * accumulator, and the creation event is authoritative about which one the round belongs to.
 */
export const contributionsRoundsFor = (
  network: Network,
  rounds: readonly ContributionsNetwork[]
): ContributionsNetwork[] =>
  network.instanceId
    ? rounds.filter(
        (round) =>
          !round.hidden &&
          round.parentInstanceId &&
          isHexEqual(round.parentInstanceId, network.instanceId!)
      )
    : []

/**
 * Newest-active first: rounds whose window is open sort before closed/upcoming ones, and within
 * each group the newest creation wins. This is the presentation default — contracts allow any
 * number of live rounds per parent.
 */
export const sortRoundsNewestActiveFirst = (
  rounds: readonly ContributionsNetwork[],
  nowSeconds: number = Math.floor(Date.now() / 1000)
): ContributionsNetwork[] => {
  const isOpen = (round: ContributionsNetwork) =>
    round.roundStart !== undefined &&
    round.roundEnd !== undefined &&
    Number(round.roundStart) <= nowSeconds &&
    nowSeconds <= Number(round.roundEnd)
  return [...rounds].sort((a, b) => {
    const openDelta = Number(isOpen(b)) - Number(isOpen(a))
    if (openDelta !== 0) return openDelta
    return Number(b.createdTimestamp ?? 0) - Number(a.createdTimestamp ?? 0)
  })
}

/**
 * Sub-pages of an address-keyed trust-graph network, including its contributions experience.
 * `contributionRounds` is this network's runtime rounds list (`contributionsRoundsFor`); callers
 * without one pass nothing and simply do not offer the Contributions tab.
 */
export const trustgraphsTabs = (
  network: Network,
  contributionRounds: readonly ContributionsNetwork[] = []
): NetworkTab[] => {
  const base = `/networks/${network.id}`

  return [
    { href: base, label: 'Overview', icon: 'overview' as const, exact: true },
    ...(contributionRounds.length > 0
      ? [
          {
            href: `${base}/contributions`,
            label: 'Contributions',
            icon: 'contributions' as const,
          },
        ]
      : []),
    ...(network.contracts.merkleGovModule
      ? [
          {
            href: `${base}/governance`,
            label: 'Governance',
            icon: 'governance' as const,
          },
        ]
      : []),
    ...(network.contracts.merkleFundDistributor ||
    contributionRounds.some((round) => round.contracts.merkleFundDistributor)
      ? [
          {
            href: `${base}/rewards`,
            label: 'Rewards',
            icon: 'rewards' as const,
          },
        ]
      : []),
    {
      href: `${base}/settings`,
      label: 'Settings',
      icon: 'settings' as const,
    },
  ]
}

/**
 * Composed graphs use the same network shell. Their policy controller is their governance
 * surface, and their optional distributor is the same rewards capability used elsewhere.
 */
export const compositionTabs = (
  instance: Pick<CompositionInstance, 'id' | 'controller' | 'distributor'>
): NetworkTab[] => {
  const base = `/networks/${instance.id}`

  return [
    { href: base, label: 'Overview', icon: 'overview', exact: true },
    ...(instance.controller
      ? [
          {
            href: `${base}/governance`,
            label: 'Governance',
            icon: 'governance' as const,
          },
        ]
      : []),
    ...(instance.distributor
      ? [
          {
            href: `${base}/rewards`,
            label: 'Rewards',
            icon: 'rewards' as const,
          },
        ]
      : []),
    { href: `${base}/settings`, label: 'Settings', icon: 'settings' },
  ]
}

/**
 * The trust network a round's reputation is proven against — `contributionsRoundsFor` reversed,
 * resolved against a runtime networks list (`useNetworks()` / `getCatalog()`) by the same
 * first-class parent link. A round whose parent is not in the list gets no back-link.
 */
export const trustNetworkFor = (
  round: ContributionsNetwork,
  networks: readonly Network[]
): Network | undefined =>
  round.parentInstanceId
    ? networks.find(
        (network) =>
          network.instanceId &&
          isHexEqual(network.instanceId, round.parentInstanceId!)
      )
    : undefined

/**
 * The two reachable contributions surfaces, plus the trust network that scores the raters.
 * Contributions routes do not render this as a tab row; the model exists for generic callers.
 */
export const contributionsTabs = (
  network: ContributionsNetwork,
  trustNetwork?: Network
): NetworkTab[] => {
  const base = `/networks/${network.id}`

  return [
    { href: base, label: 'Round', icon: 'overview' as const, exact: true },
    { href: `${base}/claim`, label: 'Claim' },
    // Closes the loop: the trust network offers this round as a tab, so the round has to offer
    // the way back or navigating into it is a dead end.
    ...(trustNetwork
      ? [
          {
            href: `/networks/${trustNetwork.id}`,
            label: trustNetwork.name,
            crossInstance: true,
          },
        ]
      : []),
  ]
}
