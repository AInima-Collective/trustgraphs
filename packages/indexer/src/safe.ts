import { ponder } from 'ponder:registry'
import {
  gnosisSafe,
  parentAuthorityModule,
  signerSyncModule,
} from 'ponder:schema'

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

const signerModuleToggled =
  (enabled: boolean) =>
  async ({ event, context }: { event: any; context: any }) => {
    const address = event.args.module
    const row = await context.db.find(signerSyncModule, { address })
    if (!row) return
    await context.db
      .update(signerSyncModule, { address })
      .set({ safeModuleEnabled: enabled })
    await revalidateNetwork(row.instanceId)
  }

const governedModuleToggled =
  (enabled: boolean) =>
  async ({ event, context }: { event: any; context: any }) => {
    await signerModuleToggled(enabled)({ event, context })

    const address = event.args.module
    const parentModule = await context.db.find(parentAuthorityModule, {
      address,
    })
    if (!parentModule || parentModule.childSafe !== event.log.address) return
    await context.db.update(parentAuthorityModule, { address }).set({
      enabled,
      updatedBlock: event.block.number,
      updatedTimestamp: event.block.timestamp,
      updatedTxHash: event.transaction.hash,
    })
    await revalidateNetwork(parentModule.childInstanceId)
  }

ponder.on('governedGnosisSafe:EnabledModule', governedModuleToggled(true))
ponder.on('governedGnosisSafe:DisabledModule', governedModuleToggled(false))
