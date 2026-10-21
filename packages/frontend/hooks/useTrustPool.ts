'use client'

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Hex, zeroAddress, zeroHash } from 'viem'
import {
  useAccount,
  useBlockNumber,
  usePublicClient,
  useReadContract,
  useReadContracts,
} from 'wagmi'

import { useNetwork } from '@/contexts/NetworkContext'
import { useApplicationChain } from '@/hooks/useApplicationChain'
import type { VoteType } from '@/hooks/useGovernance'
import { APIS } from '@/lib/config'
import { parseErrorMessage } from '@/lib/error'
import {
  compVotesTokenAbi,
  fractionalGovernorAbi,
  merkleStateAbi,
  poolShare,
  trustPoolAbi,
} from '@/lib/trust-pool'
import { txToast } from '@/lib/tx'
import { isHexEqual } from '@/lib/utils'
import { ponderQueries } from '@/queries/ponder'

/** `GET /trust-pools/:pool` (packages/indexer/src/api/trust-pools.ts). Bigints are strings. */
export type TrustPoolProposal = {
  proposalId: string
  proposer: Hex
  description: string
  voteStart: string
  voteEnd: string
  created: { block: string; timestamp: string; txHash: Hex }
  pool: { against: string; for: string; abstain: string; voters: number }
}

export type TrustPoolVote = {
  voter: Hex
  support: number
  score: string
  weight: string
  reason: string
  block: string
  timestamp: string
  txHash: Hex
}

const fetchIndexer = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${APIS.ponder}${path}`)
  if (!response.ok) {
    throw new Error(`Failed to load ${path}: ${response.status}`)
  }
  return (await response.json()) as T
}

/** Governor proposals are rare and the indexer catches a vote within a block or two. */
const INDEX_REFETCH_MS = 15_000

/** The pool, the governor and token it reads through, and the chain's head. */
const usePoolContext = () => {
  const { network } = useNetwork()
  const pool = network.contracts.trustPool as Hex
  const snapshot = network.contracts.merkleSnapshot
  const { targetChainId } = useApplicationChain()
  const chainId = targetChainId

  const { data: governor } = useReadContract({
    chainId,
    address: pool,
    abi: trustPoolAbi,
    functionName: 'governor',
  })
  const { data: governorMeta } = useReadContracts({
    allowFailure: false,
    contracts: [
      {
        chainId,
        address: governor,
        abi: fractionalGovernorAbi,
        functionName: 'name',
      },
      {
        chainId,
        address: governor,
        abi: fractionalGovernorAbi,
        functionName: 'token',
      },
    ],
    query: { enabled: !!governor },
  })
  const [governorName, token] = governorMeta ?? []
  const { data: tokenMeta } = useReadContracts({
    allowFailure: false,
    contracts: [
      {
        chainId,
        address: token,
        abi: compVotesTokenAbi,
        functionName: 'symbol',
      },
      {
        chainId,
        address: token,
        abi: compVotesTokenAbi,
        functionName: 'decimals',
      },
    ],
    query: { enabled: !!token },
  })
  const { data: blockNumber } = useBlockNumber({
    chainId,
    query: { refetchInterval: 12_000 },
  })

  return {
    network,
    pool,
    snapshot,
    chainId,
    governor,
    governorName,
    token,
    symbol: tokenMeta?.[0] ?? '',
    decimals: tokenMeta?.[1] ?? 18,
    blockNumber,
  }
}

/** Everything the Delegation list page shows, plus the one action it offers: delegating. */
export const useTrustPoolOverview = () => {
  const context = usePoolContext()
  const { pool, snapshot, chainId, governor, token, blockNumber } = context
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient({ chainId })
  const { wrongChain } = useApplicationChain()
  const [isDelegating, setIsDelegating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const index = useQuery({
    queryKey: ['trust-pool', pool],
    queryFn: () =>
      fetchIndexer<{ proposals: TrustPoolProposal[] }>(`/trust-pools/${pool}`),
    enabled: !!APIS.ponder,
    refetchInterval: INDEX_REFETCH_MS,
  })
  const proposals = index.data?.proposals ?? []

  // Per proposal: its state, the governor-wide tally, and the pool's power at its snapshot (only
  // readable once that block has passed).
  const { data: proposalReads } = useReadContracts({
    contracts: proposals.flatMap((proposal) => {
      const id = BigInt(proposal.proposalId)
      const voteStart = BigInt(proposal.voteStart)
      return [
        {
          chainId,
          address: governor,
          abi: fractionalGovernorAbi,
          functionName: 'state',
          args: [id],
        },
        {
          chainId,
          address: governor,
          abi: fractionalGovernorAbi,
          functionName: 'proposalVotes',
          args: [id],
        },
        {
          chainId,
          address: governor,
          abi: fractionalGovernorAbi,
          functionName: 'getVotes',
          args: [pool, blockNumber && voteStart < blockNumber ? voteStart : 0n],
        },
      ] as const
    }),
    query: { enabled: !!governor && !!blockNumber && proposals.length > 0 },
  })

  const rows = proposals.map((proposal, i) => {
    const [state, votes, poolVotes] =
      proposalReads?.slice(i * 3, i * 3 + 3) ?? []
    const started =
      blockNumber !== undefined && BigInt(proposal.voteStart) < blockNumber
    return {
      proposal,
      state: state?.result as number | undefined,
      votes: votes?.result as readonly [bigint, bigint, bigint] | undefined,
      poolVotes: started
        ? (poolVotes?.result as bigint | undefined)
        : undefined,
    }
  })

  const { data: poolPower, refetch: refetchPoolPower } = useReadContract({
    chainId,
    address: token,
    abi: compVotesTokenAbi,
    functionName: 'getCurrentVotes',
    args: [pool],
    query: { enabled: !!token },
  })

  const { data: holder, refetch: refetchHolder } = useReadContracts({
    allowFailure: false,
    contracts: [
      {
        chainId,
        address: token,
        abi: compVotesTokenAbi,
        functionName: 'balanceOf',
        args: [address ?? zeroAddress],
      },
      {
        chainId,
        address: token,
        abi: compVotesTokenAbi,
        functionName: 'delegates',
        args: [address ?? zeroAddress],
      },
    ],
    query: { enabled: !!token && !!address },
  })
  const [balance, currentDelegate] = holder ?? []
  const delegatesHere = !!currentDelegate && isHexEqual(currentDelegate, pool)

  // The member's share at the latest root: what they would wield on a proposal snapshotted now.
  const { data: latestState } = useReadContract({
    chainId,
    address: snapshot,
    abi: merkleStateAbi,
    functionName: 'getLatestState',
  })
  const { data: latestEntry } = useQuery(
    ponderQueries.merkleTreeEntry({
      snapshot,
      root: latestState?.root,
      account: address,
    })
  )
  const shareFraction =
    latestEntry && latestState && latestState.totalValue > 0n
      ? Number(BigInt(latestEntry.value)) / Number(latestState.totalValue)
      : isConnected && latestState
        ? 0
        : undefined

  const delegate = async () => {
    setError(null)
    if (!address || !publicClient || !token) return
    if (wrongChain) {
      setError('Switch networks in your wallet before delegating.')
      return
    }
    setIsDelegating(true)
    try {
      const gas = await publicClient.estimateContractGas({
        abi: compVotesTokenAbi,
        address: token,
        functionName: 'delegate',
        args: [pool],
        account: address,
      })
      await txToast({
        tx: {
          account: address,
          chainId,
          abi: compVotesTokenAbi,
          address: token,
          functionName: 'delegate',
          args: [pool],
          gas: (gas * 120n) / 100n,
        },
        successMessage: 'Delegated to this network',
      })
      await Promise.all([refetchHolder(), refetchPoolPower()])
    } catch (err) {
      setError(parseErrorMessage(err))
    } finally {
      setIsDelegating(false)
    }
  }

  return {
    ...context,
    rows,
    isLoadingProposals: index.isLoading,
    indexError: index.error,
    poolPower,
    balance,
    delegatesHere,
    shareFraction,
    isDelegating,
    delegate,
    error,
  }
}

/** One proposal: governor-wide results, the pool's split, the members' votes, and voting. */
export const useTrustPoolProposal = (proposalId: bigint | undefined) => {
  const context = usePoolContext()
  const { pool, snapshot, chainId, governor, blockNumber } = context
  const { address } = useAccount()
  const publicClient = usePublicClient({ chainId })
  const { wrongChain } = useApplicationChain()
  const [isVoting, setIsVoting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const detail = useQuery({
    queryKey: ['trust-pool', pool, 'proposal', proposalId?.toString()],
    queryFn: () =>
      fetchIndexer<{ proposal: TrustPoolProposal; votes: TrustPoolVote[] }>(
        `/trust-pools/${pool}/proposals/${proposalId}`
      ),
    enabled: !!APIS.ponder && proposalId !== undefined,
    refetchInterval: INDEX_REFETCH_MS,
    retry: (count, err) => !/: 404$/.test(err.message) && count < 3,
  })
  const proposal = detail.data?.proposal
  const voteStart = proposal ? BigInt(proposal.voteStart) : undefined
  const started =
    voteStart !== undefined &&
    blockNumber !== undefined &&
    voteStart < blockNumber
  // Before the snapshot block passes, power and quorum are not yet fixed; read them as of the
  // latest settled block so the page can still say roughly what is at stake.
  const timepoint = started
    ? voteStart
    : blockNumber !== undefined
      ? blockNumber - 1n
      : 0n
  const id = proposalId ?? 0n

  const { data: reads, refetch: refetchReads } = useReadContracts({
    contracts: [
      {
        chainId,
        address: governor,
        abi: fractionalGovernorAbi,
        functionName: 'state',
        args: [id],
      },
      {
        chainId,
        address: governor,
        abi: fractionalGovernorAbi,
        functionName: 'proposalVotes',
        args: [id],
      },
      {
        chainId,
        address: governor,
        abi: fractionalGovernorAbi,
        functionName: 'quorum',
        args: [timepoint],
      },
      {
        chainId,
        address: governor,
        abi: fractionalGovernorAbi,
        functionName: 'getVotes',
        args: [pool, timepoint],
      },
      {
        chainId,
        address: pool,
        abi: trustPoolAbi,
        functionName: 'proposalBasis',
        args: [id],
      },
      {
        chainId,
        address: snapshot,
        abi: merkleStateAbi,
        functionName: 'getStateAtBlock',
        args: [voteStart ?? 0n],
      },
      {
        chainId,
        address: pool,
        abi: trustPoolAbi,
        functionName: 'hasVoted',
        args: [id, address ?? zeroAddress],
      },
    ] as const,
    query: {
      enabled:
        !!governor && proposal !== undefined && blockNumber !== undefined,
    },
  })
  const [
    stateRead,
    votesRead,
    quorumRead,
    poolVotesRead,
    basisRead,
    rootRead,
    hasVotedRead,
  ] = reads ?? []
  const state = stateRead?.result
  const votes = votesRead?.result
  const quorum = quorumRead?.result
  const poolVotes = poolVotesRead?.result

  // The proposal's basis: pinned by its first vote, otherwise whatever the snapshot block reads
  // now (which the next vote will pin). See TrustPool's natspec on late-landing proofs.
  const pinned = basisRead?.result
  const basis =
    pinned && pinned[0] !== zeroHash
      ? { root: pinned[0], totalValue: pinned[1] }
      : rootRead?.result
        ? { root: rootRead.result.root, totalValue: rootRead.result.totalValue }
        : undefined

  const { data: entry, isLoading: isLoadingEntry } = useQuery(
    ponderQueries.merkleTreeEntry({
      snapshot,
      root: started ? basis?.root : undefined,
      account: address,
    })
  )
  const weight =
    entry && basis && poolVotes !== undefined
      ? poolShare(poolVotes, BigInt(entry.value), basis.totalValue)
      : undefined

  const memberVotes = detail.data?.votes ?? []
  const myVote = address
    ? memberVotes.find((vote) => isHexEqual(vote.voter, address))
    : undefined
  const hasVoted = hasVotedRead?.result === true || !!myVote

  const vote = async (support: VoteType, reason: string) => {
    setError(null)
    if (!address || !publicClient || !entry || proposalId === undefined) return
    if (wrongChain) {
      setError('Switch networks in your wallet before voting.')
      return
    }
    setIsVoting(true)
    try {
      const args = [
        proposalId,
        support,
        BigInt(entry.value),
        entry.proof as Hex[],
        reason,
      ] as const
      const gas = await publicClient.estimateContractGas({
        abi: trustPoolAbi,
        address: pool,
        functionName: 'vote',
        args,
        account: address,
      })
      await txToast({
        tx: {
          account: address,
          chainId,
          abi: trustPoolAbi,
          address: pool,
          functionName: 'vote',
          args,
          gas: (gas * 120n) / 100n,
        },
        successMessage: 'Vote cast!',
      })
      await Promise.all([refetchReads(), detail.refetch()])
    } catch (err) {
      setError(parseErrorMessage(err))
    } finally {
      setIsVoting(false)
    }
  }

  return {
    ...context,
    proposal,
    memberVotes,
    isLoading: detail.isLoading,
    notFound: detail.error?.message.endsWith(': 404') ?? false,
    loadError: detail.error,
    started,
    state,
    votes,
    quorum,
    poolVotes,
    entry,
    isLoadingEntry,
    weight,
    myVote,
    hasVoted,
    isVoting,
    vote,
    error,
  }
}
