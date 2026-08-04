//! What a network instance can actually DO, as a navigable list.
//!
//! One place decides which sub-pages exist for a given instance, so every page presents the same
//! navigation and any future entry point can reuse it.
//!
//! Tabs are CONTRACT-GATED, not hard-coded. A network minted by `TrustGraphFactory` has no Safe
//! gov module and no fund distributor until someone deploys them, so offering those tabs would
//! route people to a page that can only tell them the feature does not exist here.

import { CONTRIBUTIONS_NETWORKS, SEED_NETWORKS } from './config'
import { ContributionsNetwork, Network } from './types'
import { isHexEqual } from './utils'

export type NetworkTab = {
  href: string
  label: string
  icon?: 'governance' | 'distribute' | 'contributions' | 'settings'
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
 * The contributions rounds scored against THIS trust network.
 *
 * A contributions instance proves stage-1 reputation over a sibling trust network's
 * `AttestationAccumulator`, and that accumulator is the trust network's `easIndexerResolver`
 * (the accumulator is a mixin folded into it). That shared address is the only link between the
 * two instances, so it is what the lookup matches on.
 */
export const contributionsRoundsFor = (
  network: Network
): ContributionsNetwork[] =>
  CONTRIBUTIONS_NETWORKS.filter(
    (round) =>
      !round.hidden &&
      isHexEqual(
        round.contracts.trustAccumulator,
        network.contracts.easIndexerResolver
      )
  )

/** Sub-pages of an address-keyed trust-graph network, including its contributions experience. */
export const trustGraphTabs = (network: Network): NetworkTab[] => {
  const base = `/networks/${network.id}`

  return [
    { href: base, label: 'Overview', exact: true },
    ...(network.contracts.merkleGovModule
      ? [
          {
            href: `${base}/governance`,
            label: 'Governance',
            icon: 'governance' as const,
          },
        ]
      : []),
    ...(network.contracts.merkleFundDistributor
      ? [
          {
            href: `${base}/distribute`,
            label: 'Distribute',
            icon: 'distribute' as const,
          },
        ]
      : []),
    ...contributionsRoundsFor(network).map((round) => ({
      href: `/networks/${round.id}`,
      label: 'Contributions',
      icon: 'contributions' as const,
    })),
    {
      href: `${base}/settings`,
      label: 'Settings',
      icon: 'settings' as const,
    },
  ]
}

/**
 * The trust network a round's reputation is proven against — `contributionsRoundsFor` reversed.
 *
 * Resolved against the SEED rather than the runtime catalog because both sides of this link are
 * static in v1: contributions instances are not factory-minted, so the network a round was
 * deployed against is one of the shipped ones. A round whose network is not in the seed simply
 * gets no back-link.
 */
export const trustNetworkFor = (
  round: ContributionsNetwork
): Network | undefined =>
  SEED_NETWORKS.find((network) =>
    isHexEqual(
      network.contracts.easIndexerResolver,
      round.contracts.trustAccumulator
    )
  )

/** The five screens of a contributions round, plus the trust network that scores its raters. */
export const contributionsTabs = (
  network: ContributionsNetwork
): NetworkTab[] => {
  const base = `/networks/${network.id}`
  const trustNetwork = trustNetworkFor(network)

  return [
    { href: base, label: 'Round', exact: true },
    { href: `${base}/contribute`, label: 'Contribute' },
    { href: `${base}/respond`, label: 'Respond' },
    { href: `${base}/rate`, label: 'Rate' },
    { href: `${base}/payout`, label: 'Payout' },
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
