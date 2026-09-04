import { Hex } from 'viem'

import type { AttestationProvenance } from './attestation-provenance'
import { type Erc8004AgentCompact } from './erc8004'
import type { ScoreProgramProvenance } from './score-program'

export type Network = {
  /** Program discriminator; all variants publish address-keyed score tables. */
  program?: 'trust-graph' | 'trust-graph-weighted' | 'trust-compose'
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
  /** Current authority resolved from the instance's params controller (catalog networks only). */
  admin?: Hex
  /** Blocks between provable epochs, as a decimal string (catalog networks only). */
  epochLength?: string
  /** The governance-pinned params hash the snapshot enforces (catalog networks only). */
  paramsHash?: Hex
  /** Unix seconds of the creating transaction (catalog networks only). */
  createdTimestamp?: string
  /** Factory-authenticated strict EAS v2 lane. Absent means on-chain EAS only. */
  offchainLane?: {
    registry: Hex
    easDomainSeparator: Hex
    maxTotalInputs: string
  }
  /** Existing-schema lane: canonical EAS is the source and the importer is this network's accumulator. */
  importedLane?: {
    eas: Hex
    importer: Hex
    router: Hex
    schemaUid: Hex
    completeness: string
  }
  name: string
  /** Presentation image from the current network metadata revision. */
  image?: string
  /** Current constitutional profile pointer and catalog materialization status. */
  metadataURI?: string
  metadataURIHash?: Hex
  metadataRevision?: string
  metadataStatus?: string
  /** Exact current five-field profile, preserving intentional empty values. */
  profile?: {
    name: string
    description: string
    criteria: string
    image: string
    applicationUrl: string
  }
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
    /** Strict off-chain anchor registry when this is a hybrid trust graph. */
    easOffchainAnchorRegistry?: Hex
    merkleFundDistributor?: Hex
    /**
     * The Safe governance module, when this network has one. Wired outside the factory (a factory
     * instance has none until someone deploys one), so it lives in the config entry and survives
     * the catalog merge.
     */
    merkleGovModule?: Hex
    /** Shared infrastructure authenticated by deployment config for typed governance actions. */
    provingVault?: Hex
    contributionsFactory?: Hex
    /** Typed, self-describing scoring control plane for migrated/factory networks. */
    trustgraphsParamsController?: Hex
    safe?: {
      factory?: Hex
      singleton?: Hex
      proxy: Hex
      signerSyncManager?: Hex
      recoveryModule?: Hex
      executionGuard?: Hex
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
    trustShare: number
    trustDecay: number
    minWeight: number
    maxWeight: number
    trustedSeeds: Hex[]
    // Lane-2 (envelope-0) params. Both are hashed into the governance-pinned paramsHash
    // (params schema v3 hashes 17 words: version + 16 fields), so they must be threaded into the browser
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
    activitySource?: Hex
    maxInactiveBlocks?: string
    minActivityWitnesses?: number
    lastAppliedCheckpoint?: string | null
    lastSyncedTimestamp?: string | null
    lastSyncedTxHash?: Hex | null
    lastSigners?: Hex[]
    lastThreshold?: string | null
  }
  validatedThreshold: number
  /** Authenticated InstanceRegistry provenance; absent only on a static fallback catalog row. */
  scoreProgram?: ScoreProgramProvenance
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
  scoreProgram?: ScoreProgramProvenance
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
  /** The `/networks/[id]` path segment — the round's factory `instanceId`. */
  id: string
  /**
   * `keccak256(abi.encode(creator, name, salt))` — present iff this round came from the runtime
   * contributions catalog (`lib/contributions-catalog.ts`). Same value as `id` for those rows.
   */
  instanceId?: Hex
  /**
   * The PARENT trust network's registry instance id, from the factory's creation event. This is
   * the round ↔ network link (never address equality): rounds render on the parent whose
   * `instanceId` matches.
   */
  parentInstanceId?: Hex
  /** The round's admin (the parent authority that created it), catalog rows only. */
  admin?: Hex
  /** Unix seconds of the creating transaction (catalog rows only). */
  createdTimestamp?: string
  /** Round window + pool, denormalized from the creation params (catalog rows only). */
  roundStart?: string
  roundEnd?: string
  totalPool?: string
  name: string
  image?: string
  metadataURI?: string
  metadataURIHash?: Hex
  metadataRevision?: string
  metadataStatus?: string
  profile?: {
    name: string
    description: string
    criteria: string
    image: string
    applicationUrl: string
  }
  /** Parent governance module/Safe when this round is governed by its parent authority. */
  governance?: { module: Hex; safe: Hex } | null
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
    /** The shared contributions verifier. Optional: catalog rows read it from chain instead. */
    zkVerifier?: Hex
    /**
     * The round's intended payout ERC20 (the creation event's `distributorToken`). Optional and
     * presentation only — the distributor is multi-token; funding pickers default to it.
     */
    poolToken?: Hex
  }
  /** The three contribution schemas (claim / response / valuation), from the deployment. */
  schemas: NetworkSchema[]
  scoreProgram?: ScoreProgramProvenance
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
  href?: string
  uid: Hex
  schema: Hex
  provenance?: AttestationProvenance
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
