'use client'

import { useQueries, useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { type Hex, isAddress, isAddressEqual, zeroAddress } from 'viem'
import { useAccount, useBalance, usePublicClient } from 'wagmi'

import { useNetwork } from '@/contexts/NetworkContext'
import type { SafeAction } from '@/lib/actions'
import { merkleGovModuleAbi } from '@/lib/contract-abis'
import { parseErrorMessage } from '@/lib/error'
import { txToast } from '@/lib/tx'
import { usePonderQuery } from '@/lib/use-ponder-query'
import { realAddress } from '@/lib/utils'
import {
  merkleGovModule,
  merkleGovModuleProposal,
  merkleGovModuleVote,
} from '@/ponder.schema'
import { ponderQueries, ponderQueryFns } from '@/queries/ponder'

export type ProposalAction = SafeAction

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
  quorumFraction: bigint
  executionDeadlineBlock: bigint
  state: number // ProposalState enum
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
  Expired = 6,
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
  quorumRange: bigint = BigInt(1e18)
): ProposalState {
  if (proposal.cancelled) return ProposalState.Cancelled
  if (proposal.executed) return ProposalState.Executed

  if (currentBlockNumber < proposal.startBlock) return ProposalState.Pending
  if (currentBlockNumber <= proposal.endBlock) return ProposalState.Active

  // Voting has ended - check if passed
  // Contract quorum is decisive participation only. Abstentions remain visible but cannot make a
  // proposal with sub-quorum Yes/No turnout executable.
  const totalVotes = proposal.yesVotes + proposal.noVotes
  const quorumThreshold =
    (proposal.totalVotingPower * proposal.quorumFraction) / quorumRange

  if (totalVotes >= quorumThreshold && proposal.yesVotes > proposal.noVotes) {
    if (currentBlockNumber > proposal.executionDeadlineBlock) {
      return ProposalState.Expired
    }
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
  const [isSettingVoteDelegate, setIsSettingVoteDelegate] = useState(false)
  const [isExecutingProposal, setIsExecutingProposal] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Zero when the network has no gov module, and a zero-address string is truthy — so the
  // `enabled` guards below need `realAddress`, not `!!`.
  const merkleGovModuleAddress = (realAddress(
    network.contracts.merkleGovModule
  ) ?? '') as Hex

  // Read the authoritative assignment from the contract. The indexer separately retains its
  // append-only receipt history, but a just-mined revocation must take effect in this UI without
  // waiting for finality.
  const {
    data: currentVoteDelegate = zeroAddress,
    isLoading: isLoadingVoteDelegate,
    refetch: refetchVoteDelegate,
  } = useQuery({
    queryKey: ['voteDelegate', merkleGovModuleAddress, address],
    queryFn: async () => {
      if (!publicClient || !merkleGovModuleAddress || !address) {
        return zeroAddress
      }
      return publicClient.readContract({
        address: merkleGovModuleAddress,
        abi: merkleGovModuleAbi,
        functionName: 'voteDelegate',
        args: [address],
      })
    },
    enabled: !!publicClient && !!merkleGovModuleAddress && !!address,
  })

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
    return proposals.map((proposal) => {
      const state = computeProposalState(proposal, currentBlockNumber)
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
        quorumFraction: proposal.quorumFraction,
        executionDeadlineBlock: proposal.executionDeadlineBlock,
        state,
        blockNumber: proposal.blockNumber,
        timestamp: proposal.timestamp,
      }

      return { core, actions }
    })
  }, [proposals, currentBlockNumber])

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
    [
      isConnected,
      address,
      publicClient,
      merkleGovModuleAddress,
      getProposal,
      userEntriesByRoot,
    ]
  )

  const setVoteDelegate = useCallback(
    async (delegate: Hex): Promise<string | null> => {
      if (!isConnected || !address) {
        setError('Wallet not connected')
        return null
      }
      if (!publicClient || !merkleGovModuleAddress) {
        setError('MerkleGovModule contract not found')
        return null
      }
      if (!isAddress(delegate)) {
        setError('Enter a valid delegate address')
        return null
      }
      if (isAddressEqual(delegate, address)) {
        setError('You cannot delegate voting to yourself')
        return null
      }

      try {
        setError(null)
        setIsSettingVoteDelegate(true)
        const transaction = {
          address: merkleGovModuleAddress,
          abi: merkleGovModuleAbi,
          functionName: 'setVoteDelegate' as const,
          args: [delegate] as const,
          account: address,
        }
        const gasEstimate = await publicClient.estimateContractGas(transaction)
        const [receipt] = await txToast({
          tx: {
            ...transaction,
            gas: (gasEstimate * 120n) / 100n,
          },
          successMessage:
            delegate === zeroAddress
              ? 'Vote delegation revoked.'
              : 'Vote delegate configured.',
        })
        await refetchVoteDelegate()
        return receipt.transactionHash
      } catch (err: any) {
        console.error('Error setting vote delegate:', err)
        setError(`Failed to set vote delegate: ${parseErrorMessage(err)}`)
        return null
      } finally {
        setIsSettingVoteDelegate(false)
      }
    },
    [
      address,
      isConnected,
      merkleGovModuleAddress,
      publicClient,
      refetchVoteDelegate,
    ]
  )

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

        // Estimate gas
        const gasEstimate = await publicClient.estimateContractGas({
          address: merkleGovModuleAddress,
          abi: merkleGovModuleAbi,
          functionName: 'execute',
          args: [BigInt(proposalId)],
          account: address,
        })

        const [receipt] = await txToast({
          tx: {
            address: merkleGovModuleAddress,
            abi: merkleGovModuleAbi,
            functionName: 'execute',
            args: [BigInt(proposalId)],
            gas: (gasEstimate * 120n) / 100n,
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
      case ProposalState.Expired:
        return 'Expired'
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
    isCreatingProposal ||
    isCastingVote ||
    isExecutingProposal ||
    isSettingVoteDelegate

  return {
    // Loading states
    isCreatingProposal,
    isCastingVote,
    isSettingVoteDelegate,
    isExecutingProposal,
    isAnyActionLoading,
    isLoadingModule,
    isLoadingProposals,
    isLoadingUserVotes,
    isLoadingUserVotingPower,
    isLoadingSafeBalance,
    isLoadingVoteDelegate,
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
    currentBlockNumber,

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
    currentVoteDelegate,

    // Proposals data (from indexer)
    proposals: proposalsWithState,

    // Actions
    createProposal,
    castVote,
    setVoteDelegate,
    executeProposal,

    // Query helpers
    getAllProposals,
    getProposal,
    hasUserVoted,
    getUserVote,

    // Utilities
    getProposalStateText,

    // Contract addresses
    merkleGovAddress: merkleGovModuleAddress,
  }
}
