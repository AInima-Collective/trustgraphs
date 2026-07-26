import CONFIG from '../config.json'
import networks from '../networks.json'
import {
  AnyNetwork,
  ContributionsNetwork,
  HypercertsNetwork,
  Network,
} from './types'

const ALL_NETWORKS = networks as AnyNetwork[]

// The address-keyed EAS vouching networks (everything the existing pipeline consumes).
// Filter by the program tag: any program-tagged instance (hypercerts, contributions) has its own
// page and contract surface and must never enter the vouching code paths.
//
// SEED, NOT CATALOG. Trust-graph networks are created by `TrustGraphFactory` at any moment, so the
// live list is read at runtime from the indexer — `lib/catalog.ts` (isomorphic),
// `lib/catalog.server.ts` (server components) and `contexts/CatalogContext.tsx` (`useNetworks()`).
// What is left here is the seed: the curated presentation the chain does not carry (URL slug,
// `about`, `link`, Safe/gov addresses, `validatedThreshold`) and the fallback the app shows when
// the indexer cannot be reached. Reach for `useNetworks()` / `getCatalog()` unless you
// specifically want the shipped list.
export const SEED_NETWORKS = ALL_NETWORKS.filter(
  (network): network is Network =>
    network.program === undefined || network.program === 'trust-graph'
)
export const VISIBLE_SEED_NETWORKS = SEED_NETWORKS.filter(
  (network) => !network.hidden
)

// The nodeId-keyed hypercerts instances (read-only detail pages fed by the /hypercerts API).
// Static: hypercerts instances are not factory-minted in v1.
export const HYPERCERTS_NETWORKS = ALL_NETWORKS.filter(
  (network): network is HypercertsNetwork => network.program === 'hypercerts'
)
export const VISIBLE_HYPERCERTS_NETWORKS = HYPERCERTS_NETWORKS.filter(
  (network) => !network.hidden
)

// The contributions-program instances (claim / respond / rate / payout round pages).
// Static: contributions instances are not factory-minted in v1.
export const CONTRIBUTIONS_NETWORKS = ALL_NETWORKS.filter(
  (network): network is ContributionsNetwork =>
    network.program === 'contributions'
)
export const VISIBLE_CONTRIBUTIONS_NETWORKS = CONTRIBUTIONS_NETWORKS.filter(
  (network) => !network.hidden
)

export const CHAIN = CONFIG.chain
export const APIS = CONFIG.apis
export const CONTRACT_CONFIG = CONFIG.contracts
