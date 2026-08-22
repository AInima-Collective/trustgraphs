import { ponder } from 'ponder:registry'
import {
  merkleGovModule,
  merkleGovModuleProposal,
  merkleGovModuleVote,
  merkleGovVoteDelegate,
  merkleGovVoteDelegationEvent,
} from 'ponder:schema'
import type { Address } from 'viem'

import {
  ensureMerkleGovModuleRow,
  readMerkleGovModuleRow,
} from './gov-module-shared'
import { merkleGovModuleAbi } from '../../frontend/lib/contract-abis'

// Helper type for proposal actions
type ProposalAction = {
  target: string
  value: string
  data: string
  operation: number
}

const eventPosition = (event: any) => ({
  blockNumber: event.block.number,
  transactionIndex: event.transaction.transactionIndex,
  logIndex: event.log.logIndex,
  timestamp: event.block.timestamp,
  txHash: event.transaction.hash,
})

/**
 * Read and insert a module's complete state at the block Ponder is processing.
 *
 * A governed factory deploys the module before it emits `GovernedInstanceCreated`. Ponder discovers
 * the module from that later event, then replays the constructor's earlier
 * `MerkleSnapshotContractUpdated` log. That log therefore arrives before any setup handler can have
 * inserted the row. Reading the contract at the event block gives us the transaction's complete
 * post-state and makes the birth row independent of log order. The read-back itself lives in
 * src/gov-module-shared.ts, shared with the discovery handler (src/governed.ts).
 */
async function insertMerkleGovModule(context: any, address: Address) {
  const row = await readMerkleGovModuleRow(context.client, address)
  await context.db.insert(merkleGovModule).values(row).onConflictDoNothing()
  return row.proposalCount
}

async function ensureMerkleGovModule(context: any, address: Address) {
  await ensureMerkleGovModuleRow(
    context.db,
    context.client,
    merkleGovModule,
    address
  )
}

async function updateMerkleGovModule(
  context: any,
  address: Address,
  set: Record<string, unknown>
) {
  await ensureMerkleGovModule(context, address)
  await context.db.update(merkleGovModule, { address }).set(set)
}

// Setup: Initialize statically configured modules and recover any proposals that predate indexing.
ponder.on('merkleGovModule:setup', async ({ context }) => {
  for (const address of context.contracts.merkleGovModule.address || []) {
    try {
      const proposalCount = await insertMerkleGovModule(context, address)

      // Index any existing proposals
      for (let i = 1n; i <= proposalCount; i++) {
        const [proposal, , actions] = await context.client.readContract({
          address,
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

        await context.db
          .insert(merkleGovModuleProposal)
          .values({
            module: address,
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
            actions: formattedActions,
            // Use current block for setup (we don't have the original block)
            blockNumber: 0n,
            timestamp: 0n,
          })
          .onConflictDoNothing()
      }
    } catch (error) {
      // A statically configured address that cannot be read is stale: the summary file names a
      // module that is not deployed (yet) on this chain. Say so instead of hiding it — a silent
      // catch here once masked a wedged deployment for a whole session.
      console.warn(
        `gov: setup could not read merkleGovModule ${address} — stale deployment_summary.json address?`,
        error
      )
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
    quorumFraction: proposal.quorumFraction,
    actions: formattedActions,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  })

  // Update proposal count on the module
  await updateMerkleGovModule(context, event.log.address, {
    proposalCount: proposalId,
  })
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
    castBy: voter,
    delegated: false,
    delegate: null,
    reason: null,
    overridden: false,
    ...eventPosition(event),
    overrideBlockNumber: null,
    overrideTransactionIndex: null,
    overrideLogIndex: null,
    overrideTimestamp: null,
    overrideTxHash: null,
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

// VoteDelegateSet: keep both the current assignment and the append-only receipt history.
const voteDelegateSet = async ({ event, context }: any) => {
  const { principal, previousDelegate, newDelegate } = event.args
  const position = eventPosition(event)

  await context.db
    .insert(merkleGovVoteDelegate)
    .values({
      module: event.log.address,
      principal,
      delegate: newDelegate,
      ...position,
    })
    .onConflictDoUpdate({ delegate: newDelegate, ...position })

  await context.db.insert(merkleGovVoteDelegationEvent).values({
    id: event.id,
    module: event.log.address,
    principal,
    previousDelegate,
    delegate: newDelegate,
    ...position,
  })
}

ponder.on('merkleGovModule:VoteDelegateSet', voteDelegateSet)
ponder.on('governedMerkleGovModule:VoteDelegateSet', voteDelegateSet)

// DelegateVoteCast follows VoteCast in the same transaction and decorates that principal's row
// with the actual actor and event-only rationale. The vote stays provisional until an override.
const delegateVoteCast = async ({ event, context }: any) => {
  const { principal, proposalId, delegate, reason } = event.args

  await context.db
    .update(merkleGovModuleVote, {
      module: event.log.address,
      proposalId,
      voter: principal,
    })
    .set({
      castBy: delegate,
      delegated: true,
      delegate,
      reason,
    })
}

ponder.on('merkleGovModule:DelegateVoteCast', delegateVoteCast)
ponder.on('governedMerkleGovModule:DelegateVoteCast', delegateVoteCast)

// VoteOverridden is the one legal replacement. Preserve the original delegate/reason receipt,
// mark the principal as the final actor, and refresh all three tallies from contract state.
const voteOverridden = async ({ event, context }: any) => {
  const { principal, proposalId, newVoteType, votingPower } = event.args

  await context.db
    .update(merkleGovModuleVote, {
      module: event.log.address,
      proposalId,
      voter: principal,
    })
    .set({
      voteType: newVoteType,
      votingPower,
      castBy: principal,
      delegated: false,
      overridden: true,
      overrideBlockNumber: event.block.number,
      overrideTransactionIndex: event.transaction.transactionIndex,
      overrideLogIndex: event.log.logIndex,
      overrideTimestamp: event.block.timestamp,
      overrideTxHash: event.transaction.hash,
    })

  const [proposal] = await context.client.readContract({
    address: event.log.address,
    abi: merkleGovModuleAbi,
    functionName: 'getProposal',
    args: [proposalId],
  })
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

ponder.on('merkleGovModule:VoteOverridden', voteOverridden)
ponder.on('governedMerkleGovModule:VoteOverridden', voteOverridden)

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

  await updateMerkleGovModule(context, event.log.address, {
    quorum: newQuorum,
  })
}

ponder.on('merkleGovModule:QuorumUpdated', quorumUpdated)
ponder.on('governedMerkleGovModule:QuorumUpdated', quorumUpdated)

// VotingDelayUpdated: Update voting delay on the module
const votingDelayUpdated = async ({ event, context }: any) => {
  const { newDelay } = event.args

  await updateMerkleGovModule(context, event.log.address, {
    votingDelay: newDelay,
  })
}

ponder.on('merkleGovModule:VotingDelayUpdated', votingDelayUpdated)
ponder.on('governedMerkleGovModule:VotingDelayUpdated', votingDelayUpdated)

// VotingPeriodUpdated: Update voting period on the module
const votingPeriodUpdated = async ({ event, context }: any) => {
  const { newPeriod } = event.args

  await updateMerkleGovModule(context, event.log.address, {
    votingPeriod: newPeriod,
  })
}

ponder.on('merkleGovModule:VotingPeriodUpdated', votingPeriodUpdated)
ponder.on('governedMerkleGovModule:VotingPeriodUpdated', votingPeriodUpdated)

// MerkleSnapshotContractUpdated: Update merkle snapshot address on the module
const merkleSnapshotContractUpdated = async ({ event, context }: any) => {
  const { newContract } = event.args

  await updateMerkleGovModule(context, event.log.address, {
    merkleSnapshot: newContract,
  })
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

  await updateMerkleGovModule(context, event.log.address, {
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

  await updateMerkleGovModule(context, event.log.address, {
    avatar: newAvatar,
  })
}

ponder.on('merkleGovModule:AvatarSet', avatarSet)
ponder.on('governedMerkleGovModule:AvatarSet', avatarSet)

// TargetSet (from Module.sol): Update target address on the module
const targetSet = async ({ event, context }: any) => {
  const { newTarget } = event.args

  await updateMerkleGovModule(context, event.log.address, {
    target: newTarget,
  })
}

ponder.on('merkleGovModule:TargetSet', targetSet)
ponder.on('governedMerkleGovModule:TargetSet', targetSet)
