import { Client, count, inArray } from '@ponder/client'
import { ResolvedSchema } from '@ponder/react'
import { queryOptions } from '@tanstack/react-query'
import { Hex } from 'viem'

import {
  type AttestationApiRow,
  AttestationData,
  intoAttestationsData,
} from '@/lib/attestation'
import type { InstanceParamsJson } from '@/lib/catalog'
import { APIS } from '@/lib/config'
import {
  getReviewDistributionClaims,
  getReviewDistributions,
  getReviewFundDistributor,
  getReviewLatestSnapshot,
  getReviewMerkleEntry,
  isReviewRoot,
} from '@/lib/contributions-review-fixtures'
import {
  type Erc8004AccountRelations,
  type Erc8004AgentCompact,
} from '@/lib/erc8004'
import {
  REVIEW_FIXTURES_ENABLED,
  withReviewFixture,
} from '@/lib/review-fixture-query'
import {
  type ScoreProgramProvenance,
  parseScoreProgramProvenance,
  requireScoreApi,
} from '@/lib/score-program'
import { easAttestation } from '@/ponder.schema'

// Query keys for consistent caching
export const ponderKeys = {
  all: ['ponder'] as const,
  latestMerkleTree: (snapshot: string) =>
    [...ponderKeys.all, 'latestMerkleTree', snapshot] as const,
  provingTank: (instanceId: string) =>
    [...ponderKeys.all, 'provingTank', instanceId] as const,
  merkleTree: (options?: { snapshot?: string; root?: string }) =>
    [...ponderKeys.all, 'merkleTree', options] as const,
  merkleTreeEntry: (options?: {
    snapshot?: string
    root?: string
    account?: string
  }) => [...ponderKeys.all, 'merkleTreeEntry', options] as const,
  attestation: (uid: string) =>
    [...ponderKeys.all, 'attestation', uid] as const,
  attestations: (options: {
    limit: number
    offset?: number
    reverse?: boolean
    schema?: string
    attester?: string
    recipient?: string
  }) => [...ponderKeys.all, 'attestations', options] as const,
  attestationCount: (options?: {
    schema?: string
    attester?: string
    recipient?: string
  }) => [...ponderKeys.all, 'attestationCount', options] as const,
  network: (snapshot: string) =>
    [...ponderKeys.all, 'network', snapshot] as const,
  checkpointInputs: (snapshot: string, checkpointId: string) =>
    [...ponderKeys.all, 'checkpointInputs', snapshot, checkpointId] as const,
  accountNetworkProfiles: (address: Hex) =>
    [...ponderKeys.all, 'accountNetworkProfiles', address] as const,
  accountAgents: (address: Hex) =>
    [...ponderKeys.all, 'accountAgents', address] as const,
  accountNetworkProfile: (options: { address: Hex; snapshot: string }) =>
    [...ponderKeys.all, 'accountNetworkProfile', options] as const,
  hypercertsScores: (snapshot: string) =>
    [...ponderKeys.all, 'hypercertsScores', snapshot] as const,
}

/** One scored node at a hypercerts root (indexer `/hypercerts/:snapshot/scores`). */
export type HypercertsScore = {
  nodeId: string
  /** Integrity-checked DID label (keccak(did) == nodeId), or null for artifact/unlabeled nodes. */
  did: string | null
  value: string
  boundAddress: string | null
}

/** The full score set at a hypercerts snapshot's current root, plus the root's journal metadata. */
export type HypercertsScoreList = {
  snapshot: string
  root: string
  ipfsHash: string
  ipfsHashCid: string
  numNodes: number
  totalValue: string
  skippedDigest: string
  anchorAcc: string
  anchorCount: string
  timestamp: string
  scores: HypercertsScore[]
  scoreProgram: ScoreProgramProvenance
}

export type FollowerCount = {
  timestamp: number
  twitterAccount: string
  followers: number
}

export type AttestationCount = {
  account: string
  sent: number
  received: number
}

export type MerkleMetadata = {
  root: string
  ipfsHash: string
  ipfsHashCid: string
  numAccounts: number
  totalValue: string
  sources: Array<{
    name: string
    metadata: any
  }>
  blockNumber: string
  timestamp: string
}

export type MerkleEntry = {
  account: string
  value: string
  proof: string[]
  sent?: number
  received?: number
}

/**
 * What `/vault/:instanceId` returns. `funded: false` collapses to the two-field shape, because an
 * unfunded instance has no balance, no burn rate and no runway to report — inventing zeros for
 * them would make "not funded" look like "funded and empty", which are different situations with
 * different fixes.
 */
export type ProvingTankResponse =
  | { funded: false; instanceId: string }
  | {
      funded: true
      instanceId: string
      vault: string
      snapshot: string
      /** Added with the settings endpoint extension; optional during rolling indexer deploys. */
      program?: string
      ethBalance: string
      usdcBalance: string
      totalDepositedEth: string
      totalDepositedUsdc: string
      totalSpentEth: string
      totalSpentUsdc: string
      lastPaidBlock: string
      withdrawalReadyAt: string
      updatedAt?: string
      burn: {
        windowSeconds: number
        rootsInWindow: number
        spentEth: string
        spentUsdc: string
        /** Settled fee + gas value, in the vault's 1e8 USD scale. */
        spentUsd?: string
      }
      lastPaidAt: number | null
      /** Roots that landed but paid nothing since the last payment: the tank-ran-dry signal. */
      unpaidRootsSinceLastPayment: number
      recentDeposits?: Array<{
        id: string
        token: string
        from: string
        amount: string
        blockNumber: string
        timestamp: string
      }>
      recentClaims?: Array<{
        id: string
        checkpointId: string
        recipient: string | null
        submitter: string | null
        feeUsd: string
        gasUsd: string
        ethSpent: string
        usdcSpent: string
        skipped: boolean
        reason: number
        blockNumber: string
        timestamp: string
      }>
    }

export type MerkleTreeResponse = {
  tree: MerkleMetadata
  entries: MerkleEntry[]
  scoreProgram: ScoreProgramProvenance
}

export type MerkleTreeEntryResponse = {
  entry: {
    account: string
    value: string
    proof: string[]
  }
  scoreProgram: ScoreProgramProvenance
}

export type AttestationUID = {
  uid: `0x${string}`
  timestamp: number
}

export type NetworkData = {
  accounts: {
    account: Hex
    value: string
    sent: number
    received: number
    agents: Erc8004AgentCompact[]
  }[]
  attestations: AttestationData[]
  scoreProgram: ScoreProgramProvenance
}

export type CheckpointInputsResponse = {
  snapshot: Hex
  accumulator: Hex
  checkpointId: string
  cutoff: {
    blockNumber: string
    logIndex: number
    timestamp: string
    transactionHash: Hex
  }
  inputs: Array<{
    kind: number
    attester: Hex
    recipient: Hex
    uid: Hex
    data: Hex
    blockTimestamp: string
    blockNumber: string
    logIndex: number
    txHash: Hex
  }>
  scoreProgram: ScoreProgramProvenance
}

const parseMerkleScoreProgram = (value: unknown) => {
  const scoreProgram = parseScoreProgramProvenance(value)
  requireScoreApi(scoreProgram.programId, scoreProgram.outputDomain, 'merkle')
  return scoreProgram
}

export type ParameterVersionState =
  | 'current-unpinned'
  | 'active'
  | 'superseded'
  | 'inconsistent'

export type ParameterHistoryResponse = {
  instanceId: Hex
  controller: Hex | null
  currentVersion: string | null
  currentParamsHash: Hex
  control: 'typed' | 'legacy'
  versions: Array<{
    version: string
    paramsHash: Hex
    previousParamsHash: Hex
    params: InstanceParamsJson
    trustedSeeds: Hex[]
    evidenceURI: string
    executor: Hex
    executedAtBlock: string
    executedTimestamp: string
    executedTxHash: Hex
    firstCheckpoint: string | null
    firstCheckpointBlock: string | null
    firstCheckpointTimestamp: string | null
    firstCheckpointTxHash: Hex | null
    state: ParameterVersionState
    valid: boolean
    invalidReason: string | null
  }>
}

export type NetworkProfile = {
  scoreProgram: ScoreProgramProvenance
  /** The chain ID of the merkle snapshot contract. */
  chainId: string
  /** The address of the merkle snapshot contract. */
  merkleSnapshotContract: string
  /** The root of the merkle tree. */
  merkleRoot: string
  /** The IPFS hash of the merkle tree. */
  merkleIpfsHash: string
  /** The rank of this account in the network. 0 if not found. */
  rank: number
  /** The trust score of this account in the network. 0 if not found. */
  score: string
  /** Whether or not this account is validated. */
  validated: boolean
  /** Attestation UIDs given by this account that are counted for the network. */
  attestationsGiven: {
    /** Attestation UIDs sent by this account if it's in the network (only the latest per-recipient is counted). */
    inNetwork: string[]
    /** Attestation UIDs sent by this account if it's out of the network or old duplicates to in-network accounts. */
    outOfNetwork: string[]
  }
  /** Attestation UIDs received by this account by in-network and out-of-network accounts. */
  attestationsReceived: {
    /** Attestation UIDs received by this account from in-network accounts. */
    inNetwork: string[]
    /** Attestation UIDs received by this account from out-of-network accounts (or old duplicates from in-network accounts). */
    outOfNetwork: string[]
  }
}

export const ponderQueries = {
  accountAgents: (address: Hex) =>
    queryOptions({
      queryKey: ponderKeys.accountAgents(address),
      queryFn: async (): Promise<Erc8004AccountRelations> => {
        const response = await fetch(
          `${APIS.ponder}/erc8004/accounts/${address}`
        )
        // Permit a rolling frontend deployment against an indexer that has not
        // exposed the ERC-8004 enrichment route yet.
        if (response.status === 404) {
          return { address, owns: [], verifiedWalletFor: [] }
        }
        if (!response.ok) {
          throw new Error(
            `Failed to fetch ERC-8004 account relations: ${response.status} ${response.statusText} (${await response.text()})`
          )
        }
        return response.json()
      },
      enabled: !!address && !!APIS.ponder,
    }),
  parameterHistory: (instanceId: string) =>
    queryOptions({
      queryKey: [...ponderKeys.all, 'parameterHistory', instanceId] as const,
      queryFn: async (): Promise<ParameterHistoryResponse> => {
        const response = await fetch(
          `${APIS.ponder}/instances/${instanceId}/params`
        )
        if (!response.ok) {
          throw new Error(
            `Parameter history unavailable: ${response.status} ${response.statusText}`
          )
        }
        return (await response.json()) as ParameterHistoryResponse
      },
      enabled: !!APIS.ponder && !!instanceId,
      refetchInterval: 10_000,
    }),
  checkpointInputs: (snapshot: string, checkpointId: string) =>
    queryOptions({
      queryKey: ponderKeys.checkpointInputs(snapshot, checkpointId),
      queryFn: async (): Promise<CheckpointInputsResponse> => {
        const response = await fetch(
          `${APIS.ponder}/network/${snapshot}/checkpoints/${checkpointId}/inputs`
        )
        if (!response.ok) {
          throw new Error(
            `Checkpoint inputs unavailable: ${response.status} ${response.statusText}`
          )
        }
        const data = (await response.json()) as CheckpointInputsResponse
        const scoreProgram = parseScoreProgramProvenance(data.scoreProgram)
        if (
          scoreProgram.programName !== 'trust-graph' &&
          scoreProgram.programName !== 'trust-graph-weighted'
        ) {
          throw new Error(
            `${scoreProgram.programName} is not a vouch-network checkpoint response`
          )
        }
        return { ...data, scoreProgram }
      },
      enabled: !!APIS.ponder && !!snapshot && !!checkpointId,
      staleTime: Infinity,
    }),
  hypercertsScores: (snapshot: string) =>
    queryOptions({
      queryKey: ponderKeys.hypercertsScores(snapshot),
      queryFn: async () => {
        const response = await fetch(
          `${APIS.ponder}/hypercerts/${snapshot}/scores`
        )

        if (response.ok) {
          const data = (await response.json()) as HypercertsScoreList
          data.scoreProgram = parseScoreProgramProvenance(
            data.scoreProgram,
            'hypercerts'
          )
          return data
        } else {
          if (response.status === 404) {
            // No root indexed yet for this instance.
            return null
          }

          throw new Error(
            `Failed to fetch hypercerts scores: ${response.status} ${
              response.statusText
            } (${await response.text()})`
          )
        }
      },
      enabled: !!APIS.ponder && !!snapshot,
    }),
  /**
   * The proving tank for one instance: what is in it, how fast it is going, and how long that
   * leaves. `funded: false` is a normal answer, not an error — most instances are curated,
   * self-proving, or simply not being proven, and the UI has to be able to say so.
   */
  provingTank: (instanceId: string) =>
    queryOptions({
      queryKey: ponderKeys.provingTank(instanceId),
      queryFn: async (): Promise<ProvingTankResponse> => {
        const response = await fetch(`${APIS.ponder}/vault/${instanceId}`)
        if (!response.ok) {
          throw new Error(
            `Failed to fetch the proving tank: ${response.status}`
          )
        }
        return (await response.json()) as ProvingTankResponse
      },
      enabled: !!APIS.ponder && !!instanceId,
      // The tank moves once per epoch at most. Refetching it every few seconds would cost more
      // than the information is worth.
      staleTime: 60_000,
    }),
  latestMerkleTree: (snapshot: string) =>
    queryOptions({
      queryKey: ponderKeys.latestMerkleTree(snapshot),
      queryFn: async () => {
        const response = await fetch(
          `${APIS.ponder}/merkle/${snapshot}/current`
        )

        if (response.ok) {
          const data = (await response.json()) as MerkleTreeResponse

          // Sort entries by value (descending) for ranking
          const sortedEntries = data.entries.sort((a, b) => {
            const aValue = BigInt(a.value)
            const bValue = BigInt(b.value)
            return bValue > aValue ? 1 : bValue < aValue ? -1 : 0
          })

          return {
            tree: data.tree,
            entries: sortedEntries,
            scoreProgram: parseMerkleScoreProgram(data.scoreProgram),
          }
        } else {
          if (response.status === 404) {
            return null
          }

          throw new Error(
            `Failed to fetch latest merkle tree: ${response.status} ${
              response.statusText
            } (${await response.text()})`
          )
        }
      },
      enabled: !!APIS.ponder && !!snapshot,
    }),
  merkleTree: (options?: { snapshot?: string; root?: string }) =>
    queryOptions({
      queryKey: ponderKeys.merkleTree(options),
      queryFn: async () => {
        if (!options?.root) {
          throw new Error('Root is required for merkle tree query')
        }

        const response = await fetch(
          `${APIS.ponder}/merkle/${options.snapshot}/${options.root}`
        )

        if (response.ok) {
          const data = (await response.json()) as MerkleTreeResponse

          // Sort entries by value (descending) for ranking
          const sortedEntries = data.entries.sort((a, b) => {
            const aValue = BigInt(a.value)
            const bValue = BigInt(b.value)
            return bValue > aValue ? 1 : bValue < aValue ? -1 : 0
          })

          return {
            tree: data.tree,
            entries: sortedEntries,
            scoreProgram: parseMerkleScoreProgram(data.scoreProgram),
          }
        } else {
          if (response.status === 404) {
            return null
          }

          throw new Error(
            `Failed to fetch merkle tree: ${response.status} ${
              response.statusText
            } (${await response.text()})`
          )
        }
      },
      enabled: !!options?.snapshot && !!options?.root && !!APIS.ponder,
    }),
  merkleTreeEntry: (options?: {
    snapshot?: string
    root?: string
    account?: string
  }) =>
    queryOptions({
      queryKey: ponderKeys.merkleTreeEntry(options),
      queryFn: async () => {
        if (!options?.root) {
          throw new Error('Root is required for merkle tree query')
        }
        if (!options?.account) {
          throw new Error('Account is required for merkle tree entry query')
        }

        if (REVIEW_FIXTURES_ENABLED) {
          return isReviewRoot(options.root) ? getReviewMerkleEntry() : null
        }

        const response = await fetch(
          `${APIS.ponder}/merkle/${options.snapshot}/${options.root}/${options.account}`
        )

        if (response.ok) {
          const { entry, scoreProgram } =
            (await response.json()) as MerkleTreeEntryResponse
          parseMerkleScoreProgram(scoreProgram)
          return entry
        } else {
          if (response.status === 404) {
            return null
          }

          throw new Error(
            `Failed to fetch merkle tree entry: ${response.status} ${
              response.statusText
            } (${await response.text()})`
          )
        }
      },
      enabled:
        !!options?.snapshot &&
        !!options?.root &&
        !!options?.account &&
        !!APIS.ponder,
    }),
  network: (snapshot: string) =>
    queryOptions({
      queryKey: ponderKeys.network(snapshot),
      queryFn: async (): Promise<NetworkData | null> => {
        const response = await fetch(`${APIS.ponder}/network/${snapshot}`)

        if (response.ok) {
          const data = await response.json()

          return {
            // Empty fallback keeps rolling frontend/indexer deploys compatible.
            accounts: data.accounts.map(
              (
                account: Omit<NetworkData['accounts'][number], 'agents'> & {
                  agents?: Erc8004AgentCompact[]
                }
              ) => ({ ...account, agents: account.agents ?? [] })
            ),
            attestations: intoAttestationsData(
              data.attestations as AttestationApiRow[]
            ),
            scoreProgram: (() => {
              const scoreProgram = parseScoreProgramProvenance(
                data.scoreProgram
              )
              if (
                scoreProgram.programName !== 'trust-graph' &&
                scoreProgram.programName !== 'trust-graph-weighted'
              ) {
                throw new Error(
                  `${scoreProgram.programName} is not a vouch-network response`
                )
              }
              return scoreProgram
            })(),
          }
        } else {
          if (response.status === 404) {
            return null
          }

          throw new Error(
            `Failed to fetch network: ${response.status} ${
              response.statusText
            } (${await response.text()})`
          )
        }
      },
      enabled: !!APIS.ponder && !!snapshot,
    }),
  accountNetworkProfiles: (address: Hex) =>
    queryOptions({
      queryKey: ponderKeys.accountNetworkProfiles(address),
      queryFn: async () => {
        const response = await fetch(
          `${APIS.ponder}/account/${address}/networks`
        )
        if (response.ok) {
          const { networks } = (await response.json()) as {
            networks: NetworkProfile[]
          }
          return networks.map((network) => ({
            ...network,
            scoreProgram: parseMerkleScoreProgram(network.scoreProgram),
          }))
        } else {
          throw new Error(
            `Failed to fetch account network profiles: ${response.status} ${response.statusText} (${await response.text()})`
          )
        }
      },
      enabled: !!address && !!APIS.ponder,
    }),
  accountNetworkProfile: (options: { address: Hex; snapshot: string }) =>
    queryOptions({
      queryKey: ponderKeys.accountNetworkProfile(options),
      queryFn: async () => {
        const response = await fetch(
          `${APIS.ponder}/account/${options.address}/network/${options.snapshot}`
        )
        if (response.ok) {
          const { network } = (await response.json()) as {
            network: NetworkProfile
          }
          return {
            ...network,
            scoreProgram: parseMerkleScoreProgram(network.scoreProgram),
          }
        } else {
          throw new Error(
            `Failed to fetch account network profile: ${response.status} ${response.statusText} (${await response.text()})`
          )
        }
      },
      enabled: !!options.address && !!options.snapshot && !!APIS.ponder,
    }),
}

export const ponderQueryFns = {
  getAttestation: (uid: Hex) => (db: Client<ResolvedSchema>['db']) =>
    db.query.easAttestation.findFirst({
      where: (t, { eq }) => eq(t.uid, uid),
    }),
  getAttestationsGiven:
    (options: { address: Hex; schema?: Hex[] }) =>
    (db: Client<ResolvedSchema>['db']) =>
      db.query.easAttestation.findMany({
        where: (t, { eq, ne, and }) =>
          and(
            // filter by attester
            eq(t.attester, options.address),
            // filter by schema if provided
            options.schema ? inArray(t.schema, options.schema) : undefined,
            // not self-attested
            ne(t.attester, t.recipient),
            // not revoked
            eq(t.revocationTime, 0n)
          ),
        orderBy: (t, { desc }) => desc(t.timestamp),
        limit: 100,
      }),
  getAttestationsReceived:
    (options: { address: Hex; schema?: Hex[] }) =>
    (db: Client<ResolvedSchema>['db']) =>
      db.query.easAttestation.findMany({
        where: (t, { eq, ne, and }) =>
          and(
            // filter by recipient
            eq(t.recipient, options.address),
            // filter by schema if provided
            options.schema ? inArray(t.schema, options.schema) : undefined,
            // not self-attested
            ne(t.attester, t.recipient),
            // not revoked
            eq(t.revocationTime, 0n)
          ),
        orderBy: (t, { desc }) => desc(t.timestamp),
        limit: 100,
      }),
  getAttestationCount: (db: Client<ResolvedSchema>['db']) =>
    db.select({ count: count(easAttestation.uid) }).from(easAttestation),
  getAttestations:
    (options: {
      /** The account to filter attestations by. */
      account?: Hex
      /** The schema to filter attestations by. */
      schema?: Hex
      /** The timestamp order to sort attestations by. */
      order?: 'asc' | 'desc'
      /** The limit of attestations to return. */
      limit?: number
      /** Include revoked attestations (default: false). */
      includeRevoked?: boolean
      /** Include self-attested attestations (default: false). */
      includeSelfAttests?: boolean
    }) =>
    (db: Client<ResolvedSchema>['db']) =>
      db.query.easAttestation.findMany({
        where: (t, { and, or, ne, eq }) =>
          and(
            // Filter by account
            options.account
              ? or(
                  eq(t.attester, options.account),
                  eq(t.recipient, options.account)
                )
              : undefined,
            // Filter by schema
            options.schema ? eq(t.schema, options.schema) : undefined,
            // Filter by revoked
            !options.includeRevoked ? eq(t.revocationTime, 0n) : undefined,
            // Filter by self-attested
            !options.includeSelfAttests
              ? ne(t.attester, t.recipient)
              : undefined
          ),
        orderBy: (t, { asc, desc }) =>
          options.order === 'asc' ? asc(t.timestamp) : desc(t.timestamp),
        limit: options.limit ?? 100,
      }),
  // `distributor` here is the DISTRIBUTOR CONTRACT, matching `getFundDistributionClaims` and both
  // call sites (the distribute + payout screens pass `contracts.merkleFundDistributor`). Filter on
  // the contract column: `merkleFundDistribution.distributor` is the funder account that called
  // `distribute()`, so matching it against a contract address never returns a row.
  getFundDistributions: (distributor: Hex, limit: number = 100) =>
    withReviewFixture(
      (db: Client<ResolvedSchema>['db']) =>
        db.query.merkleFundDistribution.findMany({
          where: (t, { eq }) => eq(t.merkleFundDistributor, distributor),
          orderBy: (t, { desc }) => desc(t.timestamp),
          limit,
        }),
      getReviewDistributions
    ),
  getFundDistributionClaims: (options: {
    distributor: Hex
    account?: Hex
    limit?: number
  }) =>
    withReviewFixture(
      (db: Client<ResolvedSchema>['db']) =>
        db.query.merkleFundDistributionClaim.findMany({
          where: (t, { and, eq }) =>
            and(
              eq(t.merkleFundDistributor, options.distributor),
              options.account ? eq(t.account, options.account) : undefined
            ),
          orderBy: (t, { desc }) => desc(t.timestamp),
          limit: options.limit ?? 100,
        }),
      getReviewDistributionClaims
    ),
  getLatestMerkleSnapshot: (snapshot: Hex) =>
    withReviewFixture(
      (db: Client<ResolvedSchema>['db']) =>
        db.query.merkleSnapshot.findFirst({
          where: (t, { eq }) => eq(t.address, snapshot),
          orderBy: (t, { desc }) => desc(t.timestamp),
        }),
      getReviewLatestSnapshot
    ),
  getFundDistributor: (distributor: Hex) =>
    withReviewFixture(
      (db: Client<ResolvedSchema>['db']) =>
        db.query.merkleFundDistributor.findFirst({
          where: (t, { eq }) => eq(t.address, distributor),
        }),
      getReviewFundDistributor
    ),
  getGovModule: (address: Hex) => (db: Client<ResolvedSchema>['db']) =>
    db.query.merkleGovModule.findFirst({
      where: (t, { eq }) => eq(t.address, address),
    }),
  getGovModuleProposals:
    (address: Hex, limit: number = 100) =>
    (db: Client<ResolvedSchema>['db']) =>
      db.query.merkleGovModuleProposal.findMany({
        where: (t, { eq }) => eq(t.module, address),
        orderBy: (t, { desc }) => desc(t.id),
        limit,
      }),
  getGovModuleVotes:
    (options: {
      address: Hex
      voter?: Hex
      proposalId?: bigint
      limit?: number
    }) =>
    (db: Client<ResolvedSchema>['db']) =>
      db.query.merkleGovModuleVote.findMany({
        where: (t, { and, eq }) =>
          and(
            eq(t.module, options.address),
            options.voter ? eq(t.voter, options.voter) : undefined,
            options.proposalId !== undefined
              ? eq(t.proposalId, options.proposalId)
              : undefined
          ),
        orderBy: (t, { desc }) => desc(t.timestamp),
        limit: options.limit ?? 100,
      }),
  getGovVoteDelegate:
    (options: { address: Hex; principal: Hex }) =>
    (db: Client<ResolvedSchema>['db']) =>
      db.query.merkleGovVoteDelegate.findFirst({
        where: (t, { and, eq }) =>
          and(
            eq(t.module, options.address),
            eq(t.principal, options.principal)
          ),
      }),
  getProofSubmission:
    (options: { snapshot: Hex; root: Hex }) =>
    (db: Client<ResolvedSchema>['db']) =>
      db.query.proofSubmission.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.snapshot, options.snapshot), eq(t.root, options.root)),
        orderBy: (t, { desc }) => desc(t.blockNumber),
      }),
  getGnosisSafe: (address: Hex) => (db: Client<ResolvedSchema>['db']) =>
    db.query.gnosisSafe.findFirst({
      where: (t, { eq }) => eq(t.address, address),
    }),
}
