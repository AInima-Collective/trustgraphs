import { Hex } from 'viem'

import { type Erc8004AgentCompact } from './erc8004'

export type Network = {
  /** Program discriminator; absent/'trust-graph' = the address-keyed EAS vouching network. */
  program?: 'trust-graph'
  /**
   * The `/networks/[id]` path segment. For a network created through `TrustgraphsFactory` this is
   * its `instanceId`; networks that predate the factory keep the human slug from
   * `config/networks.<env>.json` so existing links keep working.
   */
  id: string
  /**
   * `keccak256(abi.encode(creator, name, salt))` — present iff this network came from the runtime
   * catalog (`lib/catalog.ts`). Always resolvable as a `/networks/[id]` segment, even when `id` is
   * a config slug.
   */
  instanceId?: Hex
  /** The instance admin from `InstanceCreated` (catalog networks only). */
  admin?: Hex
  /** Blocks between provable epochs, as a decimal string (catalog networks only). */
  epochLength?: string
  /** The governance-pinned params hash the snapshot enforces (catalog networks only). */
  paramsHash?: Hex
  /** Unix seconds of the creating transaction (catalog networks only). */
  createdTimestamp?: string
  name: string
  hidden?: boolean
  link?: {
    prefix: string
    label: string
    href: string
  }
  about: string
  callToAction?: {
    label: string
    href: string
  }
  /** Optional static "apply to join" URL for this network (rendered on the network and
   * account pages when present). Generic replacement for bespoke application integrations;
   * the future instance factory carries the same link inside instance metadataURI. */
  applicationUrl?: string
  criteria: string
  contracts: {
    merkleSnapshot: Hex
    easIndexerResolver: Hex
    merkleFundDistributor?: Hex
    /**
     * The Safe governance module, when this network has one. Wired outside the factory (a factory
     * instance has none until someone deploys one), so it lives in the config entry and survives
     * the catalog merge.
     */
    merkleGovModule?: Hex
    /** Typed, self-describing scoring control plane for migrated/factory networks. */
    trustgraphsParamsController?: Hex
    safe?: {
      factory?: Hex
      singleton?: Hex
      proxy: Hex
      signerSyncManager?: Hex
    }
  }
  schemas: NetworkSchema[]
  pagerank: {
    enabled: boolean
    /**
     * `Params.totalPool`. A decimal string when it comes from the catalog: the on-chain value is
     * routinely 1e24, which a JS number cannot represent exactly, and it is hashed into
     * `paramsHash`. Numbers are still accepted for the hand-written config entries.
     */
    pointsPool: number | string
    trustMultiplier: number
    trustShare: number
    trustDecay: number
    minWeight: number
    maxWeight: number
    trustedSeeds: Hex[]
    // Lane-2 (envelope-0) params. Both are hashed into the governance-pinned paramsHash
    // (params schema v2 hashes 17 fields), so they must be threaded into the browser
    // recompute even though envelope signatures are verified only in-guest. Absent/empty
    // = lane 2 disabled (lane-1-only network). The other two v2 fields — the instance's
    // accumulator address and its chain id — are read from `contracts.easIndexerResolver`
    // and the configured chain, so they are not duplicated here.
    envelope0DomainSeparators?: Hex[]
    lane2MaxHeadAge?: number
  }
  safeZodiacSignerSync: {
    enabled: boolean
    active?: boolean
    paused?: boolean
    topNSigners: number
    minThreshold: number
    targetThreshold: number
    operatorInstanceId?: Hex
    verifier?: Hex
    programVKey?: Hex
    selectionParamsHash?: Hex
    lastAppliedCheckpoint?: string | null
    lastSyncedTimestamp?: string | null
    lastSyncedTxHash?: Hex | null
    lastSigners?: Hex[]
    lastThreshold?: string | null
  }
  validatedThreshold: number
}

/**
 * A hypercerts (lane-2, nodeId-keyed) instance in the network catalog. Read-only in the UI:
 * scores are proven over anchored atproto repos, so there is no attest flow, no schemas, and no
 * address-keyed member model — the detail page renders the `/hypercerts` score-list API instead.
 */
export type HypercertsNetwork = {
  program: 'hypercerts'
  id: string
  name: string
  hidden?: boolean
  link?: {
    prefix: string
    label: string
    href: string
  }
  about: string
  callToAction?: {
    label: string
    href: string
  }
  /** Optional static "apply to join" URL for this network (rendered on the network and
   * account pages when present). Generic replacement for bespoke application integrations;
   * the future instance factory carries the same link inside instance metadataURI. */
  applicationUrl?: string
  criteria?: string
  contracts: {
    merkleSnapshot: Hex
    anchorRegistry?: Hex
  }
}

/**
 * A contributions-program instance in the network catalog: a funding round where members claim
 * contributions, respond to being named, and rate each other's work via EAS attestations against
 * the instance's `ContributionResolver`. Payouts flow through the instance's own
 * `MerkleFundDistributor` once the round's proven root lands on its `MerkleSnapshot`.
 * Address-keyed like the vouching networks, but with no vouch/pagerank surface of its own —
 * stage-1 reputation is proven over the sibling trust network's accumulator.
 */
export type ContributionsNetwork = {
  program: 'contributions'
  id: string
  name: string
  hidden?: boolean
  link?: {
    prefix: string
    label: string
    href: string
  }
  about: string
  callToAction?: {
    label: string
    href: string
  }
  /** Optional static "apply to join" URL for this network (rendered on the network and
   * account pages when present). Generic replacement for bespoke application integrations;
   * the future instance factory carries the same link inside instance metadataURI. */
  applicationUrl?: string
  criteria?: string
  contracts: {
    merkleSnapshot: Hex
    contributionResolver: Hex
    trustAccumulatorMirror: Hex
    trustAccumulator: Hex
    merkleFundDistributor: Hex
    zkVerifier: Hex
    /** The round's pool ERC20 (TestUSDC locally, 6 decimals). */
    poolToken: Hex
  }
  /** The three contribution schemas (claim / response / valuation), from the deployment. */
  schemas: NetworkSchema[]
}

export type AnyNetwork = Network | HypercertsNetwork | ContributionsNetwork

export type NetworkSchema = {
  uid: Hex
  key: string
  name: string
  description: string
  resolver: Hex
  revocable: boolean
  schema: string
  fields: { name: string; type: string }[]
}

export interface NetworkGraphNode {
  href: string
  label: string
  value: bigint
  x: number
  y: number
  size: number
  sent: number
  received: number
  isSeed: boolean
  /** Current verified-wallet identities; presentation only, never a score input. */
  agents: Erc8004AgentCompact[]
  color?: string
}

export type NetworkGraphEdge = {
  href: string
  label: string
  size: number
  color?: string
  confidence: number | null
  comment?: string
  status: 'verified' | 'expired' | 'revoked'
  formattedTime: string
  formattedTimeAgo: string
  type?: 'straight' | 'curved'
  curvature?: number
} & (
  | {
      parallelIndex: number
      parallelMinIndex?: number
      parallelMaxIndex: number
    }
  | {
      parallelIndex?: null
      parallelMinIndex?: null
      parallelMaxIndex?: null
    }
)

export type NetworkEntry = {
  account: Hex
  ensName?: string
  value: string
  rank: number
  sent: number
  received: number
  agents: Erc8004AgentCompact[]
}
