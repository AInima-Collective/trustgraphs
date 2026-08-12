import { ponder } from 'ponder:registry'
import { gnosisSafe } from 'ponder:schema'

import { revalidateNetwork } from './utils'
import { gnosisSafeAbi } from '../../frontend/lib/contract-abis'

const syncSafe = async ({ event, context }: { event: any; context: any }) => {
  const [owners, threshold] = await Promise.all([
    context.client.readContract({
      address: event.log.address,
      abi: gnosisSafeAbi,
      functionName: 'getOwners',
    }),
    context.client.readContract({
      address: event.log.address,
      abi: gnosisSafeAbi,
      functionName: 'getThreshold',
    }),
  ])

  await context.db
    .insert(gnosisSafe)
    .values({
      address: event.log.address,
      chainId: `${context.chain.id}`,
      owners: [...owners],
      threshold,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
    })
    .onConflictDoUpdate({
      owners: [...owners],
      threshold,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
    })

  await revalidateNetwork()
}

// Setup: Initialize the safe state from the contract
ponder.on('gnosisSafe:setup', async ({ context }) => {
  for (const safeAddress of context.contracts.gnosisSafe.address || []) {
    try {
      // Read owners and threshold from the contract
      const [owners, threshold] = await Promise.all([
        context.client.readContract({
          address: safeAddress,
          abi: gnosisSafeAbi,
          functionName: 'getOwners',
        }),
        context.client.readContract({
          address: safeAddress,
          abi: gnosisSafeAbi,
          functionName: 'getThreshold',
        }),
      ])

      await context.db.insert(gnosisSafe).values({
        address: safeAddress,
        chainId: `${context.chain.id}`,
        owners: [...owners],
        threshold,
        blockNumber: 0n,
        timestamp: 0n,
      })
    } catch {
      // Contract may not be deployed yet
    }
  }
})

// AddedOwner: Add a new owner to the safe
ponder.on('gnosisSafe:AddedOwner', syncSafe)

// RemovedOwner: Remove an owner from the safe
ponder.on('gnosisSafe:RemovedOwner', syncSafe)

// ChangedThreshold: Update the threshold
ponder.on('gnosisSafe:ChangedThreshold', syncSafe)

// Safes created through GovernedTrustgraphsFactory are discovered from its event rather than the
// static deployment summary. Their setup emits AddedOwner/ChangedThreshold in the creation block,
// so the same canonical read-back handler initializes and maintains them without a config edit.
ponder.on('governedGnosisSafe:AddedOwner', syncSafe)
ponder.on('governedGnosisSafe:RemovedOwner', syncSafe)
ponder.on('governedGnosisSafe:ChangedThreshold', syncSafe)
