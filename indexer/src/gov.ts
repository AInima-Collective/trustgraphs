import { ponder } from 'ponder:registry'
import {
  merkleGovModule,
  merkleGovModuleProposal,
  merkleGovModuleVote,
} from 'ponder:schema'

import { merkleGovModuleAbi } from '../../frontend/lib/contract-abis'

// Helper type for proposal actions
type ProposalAction = {
  target: string
  value: string
  data: string
  operation: number
}

// Setup: Initialize the module state from the contract
ponder.on('merkleGovModule:setup', async ({ context }) => {
  for (const merkleGovModuleAddress of context.contracts.merkleGovModule
    .address || []) {
    try {
      // Read all relevant state from the contract
      const [
        avatar,
        target,
        merkleSnapshotContract,
        currentMerkleRoot,
        ipfsHash,
        ipfsHashCid,
        totalVotingPower,
        proposalCount,
        votingDelay,
        votingPeriod,
        quorum,
      ] = await Promise.all([
        context.client.readContract({
          address: merkleGovModuleAddress,
          abi: merkleGovModuleAbi,
          functionName: 'avatar',
        }),
        context.client.readContract({
          address: merkleGovModuleAddress,
          abi: merkleGovModuleAbi,
          functionName: 'target',
        }),
        context.client.readContract({
          address: merkleGovModuleAddress,
          abi: merkleGovModuleAbi,
          functionName: 'merkleSnapshotContract',
        }),
        context.client.readContract({
          address: merkleGovModuleAddress,
          abi: merkleGovModuleAbi,
          functionName: 'currentMerkleRoot',
        }),
        context.client.readContract({
          address: merkleGovModuleAddress,
          abi: merkleGovModuleAbi,
          functionName: 'ipfsHash',
        }),
        context.client.readContract({
          address: merkleGovModuleAddress,
          abi: merkleGovModuleAbi,
          functionName: 'ipfsHashCid',
        }),
        context.client.readContract({
          address: merkleGovModuleAddress,
          abi: merkleGovModuleAbi,
          functionName: 'totalVotingPower',
        }),
        context.client.readContract({
          address: merkleGovModuleAddress,
          abi: merkleGovModuleAbi,
          functionName: 'proposalCount',
        }),
        context.client.readContract({
          address: merkleGovModuleAddress,
          abi: merkleGovModuleAbi,
          functionName: 'votingDelay',
        }),
        context.client.readContract({
          address: merkleGovModuleAddress,
          abi: merkleGovModuleAbi,
          functionName: 'votingPeriod',
        }),
        context.client.readContract({
          address: merkleGovModuleAddress,
          abi: merkleGovModuleAbi,
          functionName: 'quorum',
        }),
      ])

      await context.db.insert(merkleGovModule).values({
        address: merkleGovModuleAddress,
        avatar,
        target,
        merkleSnapshot: merkleSnapshotContract,
        currentMerkleRoot,
        ipfsHash,
        ipfsHashCid,
        totalVotingPower,
        proposalCount,
        votingDelay,
        votingPeriod,
        quorum,
      })

      // Index any existing proposals
      for (let i = 1n; i <= proposalCount; i++) {
        const [proposal, , actions] = await context.client.readContract({
          address: merkleGovModuleAddress,
          abi: merkleGovModuleAbi,
          functionName: 'getProposal',
          args: [i],
        })

        // Format actions for JSON storage
        const formattedActions: ProposalAction[] = actions.map((action) => ({
          target: action.target,
          value: action.value.toString(),
          data: action.data,
          operation: action.operation,
        }))

        await context.db.insert(merkleGovModuleProposal).values({
          module: merkleGovModuleAddress,
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
          actions: formattedActions,
          // Use current block for setup (we don't have the original block)
          blockNumber: 0n,
          timestamp: 0n,
        })
      }
    } catch {
      // Contract may not be deployed yet
    }
  }
})

// ProposalCreated: Create a new proposal record
const proposalCreated = async ({ event, context }: any) => {
  const { proposalId } = event.args

  // Get full proposal data including actions from contract
  const [proposal, , actions] = await context.client.readContract({
    address: event.log.address,
    abi: merkleGovModuleAbi,
    functionName: 'getProposal',
    args: [proposalId],
  })

  // Format actions for JSON storage
  const formattedActions: ProposalAction[] = actions.map(
    (action: {
      target: string
      value: bigint
      data: string
      operation: number
    }) => ({
      target: action.target,
      value: action.value.toString(),
      data: action.data,
      operation: action.operation,
    })
  )

  // Insert the new proposal
  await context.db.insert(merkleGovModuleProposal).values({
    module: event.log.address,
    id: proposalId,
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
    actions: formattedActions,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  })

  // Update proposal count on the module
  await context.db
    .update(merkleGovModule, { address: event.log.address })
    .set({ proposalCount: proposalId })
}

ponder.on('merkleGovModule:ProposalCreated', proposalCreated)
ponder.on('governedMerkleGovModule:ProposalCreated', proposalCreated)

// VoteCast: Record the vote and update vote counts on the proposal
const voteCast = async ({ event, context }: any) => {
  const { voter, proposalId, voteType, votingPower } = event.args

  // Insert the vote record
  await context.db.insert(merkleGovModuleVote).values({
    module: event.log.address,
    proposalId,
    voter,
    voteType,
    votingPower,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  })

  // Get current proposal state
  const [proposal] = await context.client.readContract({
    address: event.log.address,
    abi: merkleGovModuleAbi,
    functionName: 'getProposal',
    args: [proposalId],
  })

  // Update with the latest vote counts from the contract
  await context.db
    .update(merkleGovModuleProposal, {
      module: event.log.address,
      id: proposalId,
    })
    .set({
      yesVotes: proposal.yesVotes,
      noVotes: proposal.noVotes,
      abstainVotes: proposal.abstainVotes,
    })
}

ponder.on('merkleGovModule:VoteCast', voteCast)
ponder.on('governedMerkleGovModule:VoteCast', voteCast)

// ProposalExecuted: Mark proposal as executed
const proposalExecuted = async ({ event, context }: any) => {
  const { proposalId } = event.args

  await context.db
    .update(merkleGovModuleProposal, {
      module: event.log.address,
      id: proposalId,
    })
    .set({ executed: true })
}

ponder.on('merkleGovModule:ProposalExecuted', proposalExecuted)
ponder.on('governedMerkleGovModule:ProposalExecuted', proposalExecuted)

// ProposalCancelled: Mark proposal as cancelled
const proposalCancelled = async ({ event, context }: any) => {
  const { proposalId } = event.args

  await context.db
    .update(merkleGovModuleProposal, {
      module: event.log.address,
      id: proposalId,
    })
    .set({ cancelled: true })
}

ponder.on('merkleGovModule:ProposalCancelled', proposalCancelled)
ponder.on('governedMerkleGovModule:ProposalCancelled', proposalCancelled)

// QuorumUpdated: Update quorum on the module
const quorumUpdated = async ({ event, context }: any) => {
  const { newQuorum } = event.args

  await context.db
    .update(merkleGovModule, { address: event.log.address })
    .set({ quorum: newQuorum })
}

ponder.on('merkleGovModule:QuorumUpdated', quorumUpdated)
ponder.on('governedMerkleGovModule:QuorumUpdated', quorumUpdated)

// VotingDelayUpdated: Update voting delay on the module
const votingDelayUpdated = async ({ event, context }: any) => {
  const { newDelay } = event.args

  await context.db
    .update(merkleGovModule, { address: event.log.address })
    .set({ votingDelay: newDelay })
}

ponder.on('merkleGovModule:VotingDelayUpdated', votingDelayUpdated)
ponder.on('governedMerkleGovModule:VotingDelayUpdated', votingDelayUpdated)

// VotingPeriodUpdated: Update voting period on the module
const votingPeriodUpdated = async ({ event, context }: any) => {
  const { newPeriod } = event.args

  await context.db
    .update(merkleGovModule, { address: event.log.address })
    .set({ votingPeriod: newPeriod })
}

ponder.on('merkleGovModule:VotingPeriodUpdated', votingPeriodUpdated)
ponder.on('governedMerkleGovModule:VotingPeriodUpdated', votingPeriodUpdated)

// MerkleSnapshotContractUpdated: Update merkle snapshot address on the module
const merkleSnapshotContractUpdated = async ({ event, context }: any) => {
  const { newContract } = event.args

  await context.db
    .update(merkleGovModule, { address: event.log.address })
    .set({ merkleSnapshot: newContract })
}

ponder.on(
  'merkleGovModule:MerkleSnapshotContractUpdated',
  merkleSnapshotContractUpdated
)
ponder.on(
  'governedMerkleGovModule:MerkleSnapshotContractUpdated',
  merkleSnapshotContractUpdated
)

// MerkleRootUpdated (from IMerkleSnapshot): Update merkle state on the module
const merkleRootUpdated = async ({ event, context }: any) => {
  const { root, ipfsHash, ipfsHashCid, totalValue } = event.args

  await context.db.update(merkleGovModule, { address: event.log.address }).set({
    currentMerkleRoot: root,
    ipfsHash,
    ipfsHashCid,
    totalVotingPower: totalValue,
  })
}

ponder.on('merkleGovModule:MerkleRootUpdated', merkleRootUpdated)
ponder.on('governedMerkleGovModule:MerkleRootUpdated', merkleRootUpdated)

// AvatarSet (from Module.sol): Update avatar address on the module
const avatarSet = async ({ event, context }: any) => {
  const { newAvatar } = event.args

  await context.db
    .update(merkleGovModule, { address: event.log.address })
    .set({ avatar: newAvatar })
}

ponder.on('merkleGovModule:AvatarSet', avatarSet)
ponder.on('governedMerkleGovModule:AvatarSet', avatarSet)

// TargetSet (from Module.sol): Update target address on the module
const targetSet = async ({ event, context }: any) => {
  const { newTarget } = event.args

  await context.db
    .update(merkleGovModule, { address: event.log.address })
    .set({ target: newTarget })
}

ponder.on('merkleGovModule:TargetSet', targetSet)
ponder.on('governedMerkleGovModule:TargetSet', targetSet)
