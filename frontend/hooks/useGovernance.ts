'use client'

import { usePonderQuery } from '@ponder/react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { Hex } from 'viem'
import { useAccount, useBalance, usePublicClient } from 'wagmi'

import { useNetwork } from '@/contexts/NetworkContext'
import { merkleGovModuleAbi } from '@/lib/contract-abis'
import { parseErrorMessage } from '@/lib/error'
import { txToast } from '@/lib/tx'
import {
  merkleGovModule,
  merkleGovModuleProposal,
  merkleGovModuleVote,
} from '@/ponder.schema'
import { ponderQueries, ponderQueryFns } from '@/queries/ponder'
import { realAddress } from '@/lib/utils'

// Types matching the MerkleGovModule contract structs
export interface ProposalAction {
  target: string
  value: string
  data: string
  operation: number // Operation enum (0 = Call, 1 = DelegateCall)
  description?: string // For UI purposes
}

export interface ProposalCore {
  id: bigint
  proposer: string
  title: string
  description: string
  startBlock: bigint
  endBlock: bigint
  yesVotes: bigint
  noVotes: bigint
  abstainVotes: bigint
  executed: boolean
  cancelled: boolean
  merkleRoot: string
  totalVotingPower: bigint
  state: number // ProposalState enum
  blockNumber: bigint
  timestamp: bigint
}

export interface ProposalVote {
  voter: string
  voteType: number
  votingPower: bigint
  blockNumber: bigint
  timestamp: bigint
}

export enum ProposalState {
  Pending = 0,
  Active = 1,
  Rejected = 2,
  Passed = 3,
  Executed = 4,
  Cancelled = 5,
}

export enum VoteType {
  No = 0,
  Yes = 1,
  Abstain = 2,
}

interface VotingPowerEntry {
  account: string
  value: string
  proof: string[]
}

type _ModuleRow = typeof merkleGovModule.$inferSelect
type ProposalRow = typeof merkleGovModuleProposal.$inferSelect
type VoteRow = typeof merkleGovModuleVote.$inferSelect

// Helper to compute proposal state from indexed data
function computeProposalState(
  proposal: ProposalRow,
  currentBlockNumber: bigint,
  quorum: bigint,
  quorumRange: bigint = BigInt(1e18)
): ProposalState {
  if (proposal.cancelled) return ProposalState.Cancelled
  if (proposal.executed) return ProposalState.Executed

  if (currentBlockNumber < proposal.startBlock) return ProposalState.Pending
  if (currentBlockNumber <= proposal.endBlock) return ProposalState.Active

  // Voting has ended - check if passed
  const totalVotes =
    proposal.yesVotes + proposal.noVotes + proposal.abstainVotes
  const quorumThreshold = (proposal.totalVotingPower * quorum) / quorumRange

  if (totalVotes >= quorumThreshold && proposal.yesVotes > proposal.noVotes) {
    return ProposalState.Passed
  }

  return ProposalState.Rejected
}

const QUORUM_RANGE = 1e18

export function useGovernance() {
  const { network } = useNetwork()
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()

  // Local state
  const [isCreatingProposal, setIsCreatingProposal] = useState(false)
  const [isCastingVote, setIsCastingVote] = useState(false)
  const [isExecutingProposal, setIsExecutingProposal] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Zero when the network has no gov module, and a zero-address string is truthy — so the
  // `enabled` guards below need `realAddress`, not `!!`.
  const merkleGovModuleAddress = (realAddress(network.contracts.merkleGovModule) ??
    '') as Hex

  // Query module state from ponder
  const { data: moduleState, isLoading: isLoadingModule } = usePonderQuery({
    queryFn: ponderQueryFns.getGovModule(merkleGovModuleAddress),
    enabled: !!merkleGovModuleAddress,
  })

  // Query proposals from ponder
  const {
    data: proposals = [],
    isLoading: isLoadingProposals,
    refetch: refetchProposals,
  } = usePonderQuery({
    queryFn: ponderQueryFns.getGovModuleProposals(merkleGovModuleAddress),
    enabled: !!merkleGovModuleAddress,
  })

  // Query user's votes from ponder
  const { data: userVotes = [], isLoading: isLoadingUserVotes } =
    usePonderQuery({
      queryFn: ponderQueryFns.getGovModuleVotes({
        address: merkleGovModuleAddress,
        voter: address,
        limit: 100,
      }),
      enabled: !!address && !!merkleGovModuleAddress,
    })

  // Create a map of proposalId -> userVote for quick lookup
  const userVotesByProposal = useMemo(() => {
    const map = new Map<bigint, VoteRow>()
    for (const vote of userVotes) {
      map.set(vote.proposalId, vote)
    }
    return map
  }, [userVotes])

  // Query the current block number for state computation
  const { data: currentBlockNumber = 0n } = useQuery({
    queryKey: ['blockNumber'],
    queryFn: async () => {
      if (!publicClient) return 0n
      return publicClient.getBlockNumber()
    },
    refetchInterval: 12000, // Refetch every ~12 seconds (1 block)
    enabled: !!publicClient,
  })

  // Get user's voting power from the current merkle tree
  const { data: userVotingPower, isLoading: isLoadingUserVotingPower } =
    useQuery({
      ...ponderQueries.merkleTreeEntry({
        snapshot: network.contracts.merkleSnapshot,
        root: moduleState?.currentMerkleRoot,
        account: address,
      }),
      enabled: !!moduleState?.currentMerkleRoot && !!address,
    })

  // Get unique merkle roots from proposals for fetching user entries
  const uniqueProposalRoots = useMemo(() => {
    const roots = new Set(proposals.map((p) => p.merkleRoot))
    return Array.from(roots)
  }, [proposals])

  // Fetch user's merkle entry for each proposal's root (for voting)
  const userEntriesQueries = useQueries({
    queries: uniqueProposalRoots.map((root) => ({
      ...ponderQueries.merkleTreeEntry({
        snapshot: network.contracts.merkleSnapshot,
        root,
        account: address,
      }),
      enabled: !!address && !!root,
    })),
  })

  // Create a map of root -> userEntry for quick lookup
  const userEntriesByRoot = useMemo(() => {
    const map = new Map<string, VotingPowerEntry>()
    uniqueProposalRoots.forEach((root, index) => {
      const query = userEntriesQueries[index]
      if (query?.data) {
        map.set(root, query.data as VotingPowerEntry)
      }
    })
    return map
  }, [uniqueProposalRoots, userEntriesQueries])

  // Get Safe addresses from indexed module state
  const safeAddress = moduleState?.target
  const avatarAddress = moduleState?.avatar

  // Read Safe ETH balance using useBalance hook
  const { data: safeBalanceData, isLoading: isLoadingSafeBalance } = useBalance(
    {
      address: safeAddress as `0x${string}` | undefined,
      query: { enabled: !!safeAddress },
    }
  )

  // Transform proposals to include computed state

  const proposalsWithState = useMemo(() => {
    const quorum = moduleState?.quorum ?? 4n * BigInt(1e16) // Default 4%

    return proposals.map((proposal) => {
      const state = computeProposalState(proposal, currentBlockNumber, quorum)
      const actions = (proposal.actions as ProposalAction[]) || []

      const core: ProposalCore = {
        id: proposal.id,
        proposer: proposal.proposer,
        title: proposal.title,
        description: proposal.description,
        startBlock: proposal.startBlock,
        endBlock: proposal.endBlock,
        yesVotes: proposal.yesVotes,
        noVotes: proposal.noVotes,
        abstainVotes: proposal.abstainVotes,
        executed: proposal.executed,
        cancelled: proposal.cancelled,
        merkleRoot: proposal.merkleRoot,
        totalVotingPower: proposal.totalVotingPower,
        state,
        blockNumber: proposal.blockNumber,
        timestamp: proposal.timestamp,
      }

      return { core, actions }
    })
  }, [proposals, currentBlockNumber, moduleState?.quorum])

  // Get a single proposal by ID
  const getProposal = useCallback(
    (
      proposalId: number
    ): { core: ProposalCore; actions: ProposalAction[] } | null => {
      const proposal = proposalsWithState.find(
        (p) => Number(p.core.id) === proposalId
      )
      return proposal || null
    },
    [proposalsWithState]
  )

  // Get all proposals
  const getAllProposals = useCallback((): {
    core: ProposalCore
    actions: ProposalAction[]
  }[] => {
    return proposalsWithState
  }, [proposalsWithState])

  // Get votes for a specific proposal
  const getProposalVotes = useCallback(
    async (_proposalId: number): Promise<ProposalVote[]> => {
      // This would need a separate ponder query - for now return empty
      // Could be enhanced to fetch from ponder API
      return []
    },
    []
  )

  // Check if user has voted on a proposal
  const hasUserVoted = useCallback(
    (proposalId: number): boolean => {
      return userVotesByProposal.has(BigInt(proposalId))
    },
    [userVotesByProposal]
  )

  // Get user's vote for a proposal
  const getUserVote = useCallback(
    (proposalId: number): VoteRow | null => {
      return userVotesByProposal.get(BigInt(proposalId)) || null
    },
    [userVotesByProposal]
  )

  // Create proposal using MerkleGovModule (requires merkle proof for membership)
  const createProposal = useCallback(
    async (
      title: string,
      description: string,
      actions: ProposalAction[],
      voteType?: VoteType | null
    ): Promise<string | null> => {
      if (!isConnected || !address) {
        console.log('Wallet not connected')
        setError('Wallet not connected')
        return null
      }

      if (
        !moduleState?.currentMerkleRoot ||
        moduleState.currentMerkleRoot ===
          '0x0000000000000000000000000000000000000000000000000000000000000000'
      ) {
        console.log('No merkle root set', {
          currentMerkleRoot: moduleState?.currentMerkleRoot,
        })
        setError('No merkle root set. Governance not initialized.')
        return null
      }

      if (!userVotingPower) {
        setError(
          'No voting power found. Only members of the merkle tree can create proposals.'
        )
        return null
      }

      if (!publicClient) {
        setError('Public client not available')
        return null
      }

      if (!merkleGovModuleAddress) {
        setError('MerkleGovModule contract not found')
        return null
      }

      try {
        console.log('Starting proposal creation...')
        setError(null)
        setIsCreatingProposal(true)

        // Convert actions to the format expected by MerkleGovModule
        const targets = actions.map((action) => action.target as `0x${string}`)
        const values = actions.map((action) => BigInt(action.value || '0'))
        const calldatas = actions.map((action) => action.data as `0x${string}`)
        const operations = actions.map((action) => action.operation || 0)
        const actionDescriptions = actions.map(
          (action) => action.description || ''
        )

        console.log('Proposal parameters:', {
          title,
          description,
          targets,
          values,
          calldatas,
          operations,
          actionDescriptions,
          votingPower: userVotingPower.value,
          proof: userVotingPower.proof,
        })

        // Get current nonce
        const nonce = await publicClient.getTransactionCount({
          address: address,
          blockTag: 'pending',
        })

        // Get gas price
        const gasPrice = await publicClient.getGasPrice()

        const [receipt] =
          voteType === undefined || voteType === null
            ? await (async () => {
                const gasEstimate = await publicClient.estimateContractGas({
                  abi: merkleGovModuleAbi,
                  address: merkleGovModuleAddress,
                  functionName: 'propose',
                  args: [
                    title,
                    description,
                    targets,
                    values,
                    calldatas,
                    operations,
                    actionDescriptions,
                    BigInt(userVotingPower.value),
                    userVotingPower.proof as `0x${string}`[],
                  ],
                  account: address,
                })

                console.log('Gas estimate:', gasEstimate)

                return txToast({
                  tx: {
                    address: merkleGovModuleAddress,
                    abi: merkleGovModuleAbi,
                    functionName: 'propose',
                    args: [
                      title,
                      description,
                      targets,
                      values,
                      calldatas,
                      operations,
                      actionDescriptions,
                      BigInt(userVotingPower.value),
                      userVotingPower.proof as `0x${string}`[],
                    ],
                    gas: (gasEstimate * 120n) / 100n, // Add 20% buffer
                    gasPrice,
                    nonce,
                    type: 'legacy',
                  },
                  successMessage: 'Proposal created!',
                })
              })()
            : await (async () => {
                const gasEstimate = await publicClient.estimateContractGas({
                  address: merkleGovModuleAddress,
                  abi: merkleGovModuleAbi,
                  functionName: 'proposeWithVote',
                  args: [
                    title,
                    description,
                    targets,
                    values,
                    calldatas,
                    operations,
                    actionDescriptions,
                    BigInt(userVotingPower.value),
                    userVotingPower.proof as `0x${string}`[],
                    voteType,
                  ],
                  account: address,
                })

                console.log('Gas estimate:', gasEstimate)

                return txToast({
                  tx: {
                    address: merkleGovModuleAddress,
                    abi: merkleGovModuleAbi,
                    functionName: 'proposeWithVote',
                    args: [
                      title,
                      description,
                      targets,
                      values,
                      calldatas,
                      operations,
                      actionDescriptions,
                      BigInt(userVotingPower.value),
                      userVotingPower.proof as `0x${string}`[],
                      voteType,
                    ],
                    gas: (gasEstimate * 120n) / 100n, // Add 20% buffer
                    gasPrice,
                    nonce,
                    type: 'legacy',
                  },
                  successMessage: 'Proposal created & vote cast!',
                })
              })()

        refetchProposals()

        return receipt.transactionHash
      } catch (err: any) {
        console.error('Error creating proposal:', err)
        setError(`Failed to create proposal: ${parseErrorMessage(err)}`)
        return null
      } finally {
        setIsCreatingProposal(false)
      }
    },
    [
      isConnected,
      address,
      moduleState?.currentMerkleRoot,
      userVotingPower,
      publicClient,
    ]
  )

  // Cast vote with merkle proof (uses the proposal's snapshotted merkle root)
  const castVote = useCallback(
    async (proposalId: number, voteType: VoteType): Promise<string | null> => {
      if (!isConnected || !address) {
        setError('Wallet not connected')
        return null
      }

      if (!publicClient) {
        setError('Public client not available')
        return null
      }

      if (!merkleGovModuleAddress) {
        setError('MerkleGovModule contract not found')
        return null
      }

      try {
        setError(null)
        setIsCastingVote(true)

        // Get the proposal to find its snapshotted merkle root
        const proposal = getProposal(proposalId)
        if (!proposal) {
          setError('Proposal not found')
          return null
        }

        // Get voting power for the proposal's merkle root from our cached entries
        const votingPower = userEntriesByRoot.get(proposal.core.merkleRoot)

        if (!votingPower) {
          setError(
            'No voting power found for this proposal. You may not have been a member when it was created.'
          )
          return null
        }

        console.log('Casting vote with:', {
          proposalId: BigInt(proposalId),
          voteType,
          proposalMerkleRoot: proposal.core.merkleRoot,
          votingPower: votingPower.value,
          proof: votingPower.proof,
        })

        // Get current nonce
        const nonce = await publicClient.getTransactionCount({
          address: address,
          blockTag: 'pending',
        })

        // Estimate gas
        const gasEstimate = await publicClient.estimateContractGas({
          address: merkleGovModuleAddress,
          abi: merkleGovModuleAbi,
          functionName: 'castVote',
          args: [
            BigInt(proposalId),
            voteType,
            BigInt(votingPower.value),
            votingPower.proof as `0x${string}`[],
          ],
          account: address,
        })

        // Get gas price
        const gasPrice = await publicClient.getGasPrice()

        const [receipt] = await txToast({
          tx: {
            address: merkleGovModuleAddress,
            abi: merkleGovModuleAbi,
            functionName: 'castVote',
            args: [
              BigInt(proposalId),
              voteType,
              BigInt(votingPower.value),
              votingPower.proof as `0x${string}`[],
            ],
            gas: (gasEstimate * 120n) / 100n,
            gasPrice,
            nonce,
            type: 'legacy',
          },
          successMessage: 'Vote cast!',
        })

        return receipt.transactionHash
      } catch (err: any) {
        console.error('Error casting vote:', err)
        setError(`Failed to cast vote: ${parseErrorMessage(err)}`)
        return null
      } finally {
        setIsCastingVote(false)
      }
    },
    [isConnected, address, publicClient, getProposal, userEntriesByRoot]
  )

  // No queuing in MerkleGovModule - proposals go directly from Passed to executable
  const queueProposal = useCallback(async (_proposalId: number) => {
    console.log(
      'Queue not supported in MerkleGovModule - proposals are directly executable when succeeded'
    )
    return null
  }, [])

  // Execute proposal
  const executeProposal = useCallback(
    async (proposalId: number): Promise<string | null> => {
      if (!isConnected || !address) {
        setError('Wallet not connected')
        return null
      }

      if (!publicClient) {
        setError('Public client not available')
        return null
      }

      if (!merkleGovModuleAddress) {
        setError('MerkleGovModule contract not found')
        return null
      }

      try {
        setError(null)
        setIsExecutingProposal(true)

        console.log('Executing proposal:', proposalId)

        // Get current nonce
        const nonce = await publicClient.getTransactionCount({
          address: address,
          blockTag: 'pending',
        })

        // Estimate gas
        const gasEstimate = await publicClient.estimateContractGas({
          address: merkleGovModuleAddress,
          abi: merkleGovModuleAbi,
          functionName: 'execute',
          args: [BigInt(proposalId)],
          account: address,
        })

        // Get gas price
        const gasPrice = await publicClient.getGasPrice()

        const [receipt] = await txToast({
          tx: {
            address: merkleGovModuleAddress,
            abi: merkleGovModuleAbi,
            functionName: 'execute',
            args: [BigInt(proposalId)],
            gas: (gasEstimate * 120n) / 100n,
            gasPrice,
            nonce,
            type: 'legacy',
          },
          successMessage: 'Proposal executed!',
        })

        return receipt.transactionHash
      } catch (err: any) {
        console.error('Error executing proposal:', err)
        setError(`Failed to execute proposal: ${parseErrorMessage(err)}`)
        return null
      } finally {
        setIsExecutingProposal(false)
      }
    },
    [isConnected, address, publicClient]
  )

  const getProposalStateText = (state: number): string => {
    switch (state) {
      case ProposalState.Pending:
        return 'Pending'
      case ProposalState.Active:
        return 'Active'
      case ProposalState.Rejected:
        return 'Rejected'
      case ProposalState.Passed:
        return 'Passed'
      case ProposalState.Executed:
        return 'Executed'
      case ProposalState.Cancelled:
        return 'Cancelled'
      default:
        return 'Unknown'
    }
  }

  const canCreateProposal = useMemo((): boolean => {
    // In MerkleGovModule, only members of the merkle tree can create proposals
    return (
      !!moduleState?.currentMerkleRoot &&
      moduleState.currentMerkleRoot !==
        '0x0000000000000000000000000000000000000000000000000000000000000000' &&
      !!userVotingPower
    )
  }, [moduleState?.currentMerkleRoot, userVotingPower])

  const isAnyActionLoading =
    isCreatingProposal || isCastingVote || isExecutingProposal

  return {
    // Loading states
    isCreatingProposal,
    isCastingVote,
    isExecutingProposal,
    isAnyActionLoading,
    isLoadingModule,
    isLoadingProposals,
    isLoadingUserVotes,
    isLoadingUserVotingPower,
    isLoadingSafeBalance,
    error,

    // Governance parameters (from indexer)
    proposalCounter: moduleState?.proposalCount
      ? Number(moduleState.proposalCount)
      : 0,
    // proposalThreshold: '0', // No threshold in MerkleGovModule
    votingDelay: moduleState?.votingDelay ? Number(moduleState.votingDelay) : 0,
    votingPeriod: moduleState?.votingPeriod
      ? Number(moduleState.votingPeriod)
      : 0,
    quorum: moduleState?.quorum ? Number(moduleState.quorum) / QUORUM_RANGE : 0,
    safeBalance: safeBalanceData?.value
      ? safeBalanceData.value.toString()
      : '0',
    safeAddress: safeAddress as string | undefined,
    avatarAddress: avatarAddress as string | undefined,
    currentMerkleRoot: moduleState?.currentMerkleRoot,
    totalVotingPower: moduleState?.totalVotingPower,

    // User data
    userVotingPower: userVotingPower
      ? {
          account: address!,
          value: userVotingPower.value,
          proof: userVotingPower.proof,
        }
      : null,
    canCreateProposal,
    userVotes,
    userVotesByProposal,
    userEntriesByRoot,

    // Proposals data (from indexer)
    proposals: proposalsWithState,

    // Actions
    createProposal,
    castVote,
    queueProposal,
    executeProposal,

    // Query helpers
    getAllProposals,
    getProposal,
    getProposalVotes,
    hasUserVoted,
    getUserVote,

    // Utilities
    getProposalStateText,

    // Contract addresses
    merkleGovAddress: merkleGovModuleAddress,
  }
}
