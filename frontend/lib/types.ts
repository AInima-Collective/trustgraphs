import { Hex } from 'viem'

export type Network = {
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
