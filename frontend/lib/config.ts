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
// SEED, NOT CATALOG. Trust-graph networks are created by `TrustgraphsFactory` at any moment, so the
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
export const WEIGHTED_FACTORY = (CONFIG as { weightedFactory?: string })
  .weightedFactory as `0x${string}` | '' | undefined
export const TRUST_COMPOSE_CONFIG = (
  CONFIG as {
    trustCompose?: { factory?: string }
  }
).trustCompose as { factory?: `0x${string}` | '' } | undefined
export const GRAPH_LINEAGE_CONFIG = (
  CONFIG as {
    graphLineage?: { registry?: string }
  }
).graphLineage as { registry?: `0x${string}` | '' } | undefined
export const SIGNER_SYNC_CONFIG = (
  CONFIG as {
    signerSync?: { verifier?: string; programVKey?: string }
  }
).signerSync

/**
 * The chain's shared `ProvingVault`, or undefined on a deployment without one.
 *
 * Undefined is a real state, not a misconfiguration: a network can be curated (proven on us) or
 * self-proved by its own community, and neither needs a vault. The UI says which rather than
 * rendering an empty balance.
 */
const configuredProvingVault = (
  CONFIG.contracts as {
    ProvingVault?: string | { address?: string }
  }
).ProvingVault

// Generated configs use a bare address. Accept the older deployment-object shape too so a
// rolling frontend deployment does not temporarily lose the vault while configs catch up.
export const PROVING_VAULT = (
  typeof configuredProvingVault === 'string'
    ? configuredProvingVault
    : configuredProvingVault?.address
) as `0x${string}` | undefined
