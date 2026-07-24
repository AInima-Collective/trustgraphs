import { Hex } from 'viem'

export type Network = {
  /** Program discriminator; absent/'trust-graph' = the address-keyed EAS vouching network. */
  program?: 'trust-graph'
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
  criteria: string
  contracts: {
    merkleSnapshot: Hex
    easIndexerResolver: Hex
    merkleFundDistributor?: Hex
    safe?: {
      factory: Hex
      singleton: Hex
      proxy: Hex
      signerSyncManager: Hex
    }
  }
  schemas: NetworkSchema[]
  pagerank: {
    enabled: boolean
    pointsPool: number
    trustMultiplier: number
    trustShare: number
    trustDecay: number
    minWeight: number
    maxWeight: number
    trustedSeeds: Hex[]
    // Lane-2 (envelope-0) params. Both are hashed into the governance-pinned paramsHash
    // (journal v2 hashes 15 param fields), so they must be threaded into the browser
    // recompute even though envelope signatures are verified only in-guest. Absent/empty
    // = lane 2 disabled (lane-1-only network).
    envelope0DomainSeparators?: Hex[]
    lane2MaxHeadAge?: number
  }
  safeZodiacSignerSync: {
    enabled: boolean
    topNSigners: number
    minThreshold: number
    targetThreshold: number
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
  color?: string
}

export type NetworkGraphEdge = {
  href: string
  label: string
  size: number
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
}
