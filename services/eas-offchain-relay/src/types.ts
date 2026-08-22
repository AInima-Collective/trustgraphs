import type {
  AnchorMessage,
  LiveNodeHead,
  SignedAnchorBundle,
} from '@trustgraphs/eas-offchain-client'
import type { Address, Hex } from 'viem'

export type LaneState = {
  chainId: bigint
  registry: Address
  easAddress: Address
  easVersion: string
  schemaUid: Hex
  easDomainSeparator: Hex
  headDomainSeparator: Hex
  maxTotalInputs: bigint
  anchorCount: bigint
  workCount: bigint
  lane1LeafCount: bigint
  /** Timestamp of the finalized/latest block used for conservative future-time preflight. */
  latestBlockTimestamp: bigint
  live: LiveNodeHead
  registeredOwner?: Address
}

export interface RelayChain {
  lane(nodeId: Hex): Promise<LaneState>
  live(nodeId: Hex): Promise<LiveNodeHead>
  simulate(bundle: SignedAnchorBundle, message: AnchorMessage): Promise<void>
  anchor(bundle: SignedAnchorBundle, message: AnchorMessage): Promise<void>
}

export interface BlobStore {
  readonly name: string
  putAndRead(cid: string, bytes: Uint8Array): Promise<Uint8Array>
}

export type RelayConfig = {
  chainId: bigint
  registry: Address
  /** Public address derived from this process's signing key. Safe to expose in topology metrics. */
  relayerAddress: Address
  schemaUid: Hex
  easAddress: Address
  easVersion: string
  allowedNodeIds: ReadonlySet<string>
  storageQuorum: number
  maxBodyBytes: number
  maxPayloadBytes: number
  nodeRequestsPerMinute: number
}

export type RelaySuccess = {
  status: 'anchored'
  chainId: string
  registry: Address
  nodeId: Hex
  count: string
  head: Hex
  dataCommitment: Hex
  cid: string
}
