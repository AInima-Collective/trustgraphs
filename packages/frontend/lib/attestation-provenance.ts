import type { Hex } from 'viem'

/** Auditable origin attached to current edges in a hybrid-network response. */
export type AttestationProvenance =
  | {
      source: 'on-chain-eas'
      transactionHash: Hex | null
      blockNumber: string | null
    }
  | {
      source: 'off-chain-eas'
      registry: Hex
      nodeId: Hex
      head: Hex
      count: string
      dataCommitment: Hex
      cid: string
      anchorTransactionHash: Hex
      anchorBlock: string
      anchorTimestamp: string
      firstCommitTransactionHash: Hex
      firstCommitBlock: string
      firstCommitTimestamp: string
      storageHealthy: true
      indexerVerified: true
      gatewayIndex: number | null
      fetchLatencyMs: number | null
      revocation: 'Trustgraphs in-log only'
    }
