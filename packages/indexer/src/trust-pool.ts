/**
 * TrustPools (`contracts/src/governance/TrustPool.sol`): each recorded pool, the proposals on the
 * governors they vote on, and every member's fractional cast. Status, tallies and voting power are
 * live chain reads in the frontend; only what the chain cannot list is indexed here.
 */
import { ponder } from 'ponder:registry'
import { trustPool, trustPoolProposal, trustPoolVote } from 'ponder:schema'
import type { Hex } from 'viem'

import { trustPoolAbi } from '../abis/trustPool'

// Pools are standalone deploys with no creation event, so their network (`snapshot`) and governor
// are read once here, from the pool itself rather than the record. Both are immutables, so read
// them at the latest block: setup runs at the EARLIEST pool's block, where a later pool has no code.
ponder.on('trustPool:setup', async ({ context }) => {
  const addresses = context.contracts.trustPool.address
  for (const address of (Array.isArray(addresses) ? addresses : []) as Hex[]) {
    const read = (functionName: 'snapshot' | 'governor') =>
      context.client.readContract({
        address,
        abi: trustPoolAbi,
        functionName,
        cache: 'immutable',
      })
    try {
      const [snapshot, governor] = await Promise.all([
        read('snapshot'),
        read('governor'),
      ])
      await context.db
        .insert(trustPool)
        .values({ address, snapshot, governor })
        .onConflictDoNothing()
    } catch (error) {
      // A hand-recorded address that cannot be read is a bad record, not a reason to wedge every
      // other source: say so and leave the pool's network without a Delegation tab.
      console.warn(
        `trust pool: setup could not read ${address} — wrong manifest trustPools address?`,
        error
      )
    }
  }
})

ponder.on('trustPoolGovernor:ProposalCreated', async ({ event, context }) => {
  await context.db
    .insert(trustPoolProposal)
    .values({
      governor: event.log.address,
      proposalId: event.args.proposalId,
      proposer: event.args.proposer,
      description: event.args.description,
      voteStart: event.args.voteStart,
      voteEnd: event.args.voteEnd,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing()
})

ponder.on('trustPool:Voted', async ({ event, context }) => {
  await context.db.insert(trustPoolVote).values({
    pool: event.log.address,
    proposalId: event.args.proposalId,
    voter: event.args.voter,
    support: event.args.support,
    score: event.args.score,
    weight: event.args.weight,
    reason: event.args.reason,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  })
})
