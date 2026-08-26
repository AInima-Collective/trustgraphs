import CONFIG from '../config.json'
import networks from '../networks.json'
import { AnyNetwork, HypercertsNetwork, Network } from './types'

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

// Contribution rounds are NOT here any more: they are factory-minted
// (`ContributionsFactory`) and read at runtime from the indexer's round catalog —
// `lib/contributions-catalog.ts` / `useContributionsRounds`. There is no static fallback list,
// because a round only renders meaningfully with its indexed claims anyway.

export const CHAIN = CONFIG.chain
export const APIS = CONFIG.apis
export const CONTRACT_CONFIG = CONFIG.contracts
export const WEIGHTED_FACTORY = (CONFIG as { weightedFactory?: string })
  .weightedFactory as `0x${string}` | '' | undefined
// The governed wrapper for the weighted factory. Absent/empty means the weighted workspace does
// not offer "create with governance" on this deployment; the ungoverned path keeps working.
export const GOVERNED_WEIGHTED_FACTORY = (
  CONFIG as { governedWeightedFactory?: string }
).governedWeightedFactory as `0x${string}` | '' | undefined
// The contributions ROUND factory. Absent/empty on a deployment that has not stood it up; the
// "start a contribution round" flow then explains the feature is not available here.
export const CONTRIBUTIONS_FACTORY = (
  CONFIG as { contributionsFactory?: string }
).contributionsFactory as `0x${string}` | '' | undefined
export const TRUST_COMPOSE_CONFIG = (
  CONFIG as {
    trustCompose?: { factory?: string; governedFactory?: string }
  }
).trustCompose as
  | { factory?: `0x${string}` | ''; governedFactory?: `0x${string}` | '' }
  | undefined
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
// The fast (EPOCH_FLOOR = 1) trust-graph factory generation. When both addresses are present the
// create wizard writes through this pair so new networks can run testnet-fast epochs; absent or
// empty means only the original generation exists and the wizard keeps using that.
export const FAST_FACTORY_CONFIG = (
  CONFIG as {
    fastFactory?: { factory?: string; governedFactory?: string }
  }
).fastFactory

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
