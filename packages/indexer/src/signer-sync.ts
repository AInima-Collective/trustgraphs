import { ponder } from 'ponder:registry'
import { signerSyncModule, signerSyncRotation } from 'ponder:schema'

import { revalidateNetwork } from './utils'

/**
 * Factory signer-sync is discovered from the deployer event emitted inside the same atomic
 * governed-creation transaction. The event carries the complete policy and the canonical
 * operator key, so neither the API nor the proof scheduler needs a hand-edited manifest.
 */
ponder.on(
  'signerSyncModuleDeployer:SignerSyncModuleConfigured',
  async ({ event, context }) => {
    const {
      instanceId,
      safe,
      signerSyncModule: address,
      operatorInstanceId,
      scoreSnapshot,
      activitySource,
      accumulator,
      verifier,
      programVKey,
      selectionParamsHash,
      topN,
      minThreshold,
      targetThresholdBps,
      maxInactiveBlocks,
      minActivityWitnesses,
    } = event.args

    await context.db.insert(signerSyncModule).values({
      address,
      instanceId,
      operatorInstanceId,
      safe,
      scoreSnapshot,
      activitySource,
      accumulator,
      verifier,
      programVKey,
      selectionParamsHash,
      topN,
      minThreshold,
      targetThresholdBps,
      maxInactiveBlocks,
      minActivityWitnesses,
      paused: false,
      safeModuleEnabled: true,
      hasAppliedCheckpoint: false,
      lastAppliedCheckpoint: null,
      lastSyncedBlock: null,
      lastSyncedTimestamp: null,
      lastSyncedTxHash: null,
      createdBlock: event.block.number,
      createdTimestamp: event.block.timestamp,
      createdTxHash: event.transaction.hash,
    })

    await revalidateNetwork(instanceId)
  }
)

ponder.on(
  'governedSignerSyncModule:SignersSynced',
  async ({ event, context }) => {
    const module = event.log.address
    const row = await context.db.find(signerSyncModule, { address: module })
    if (!row) {
      // Out-of-universe guard: the module row is born from the deployer's `SignerSyncModuleConfigured` —
      // the very event that discovers this child — so a missing row means the configuration
      // predates the start block. The row is not reconstructible here (instanceId comes only from
      // the deployer event), so log and skip; never skip silently.
      console.warn(
        `signer-sync: rotation on unobserved module ${module} (configured before the start block?) — skipping`
      )
      return
    }

    await context.db.insert(signerSyncRotation).values({
      id: event.id,
      module,
      instanceId: row.instanceId,
      checkpointId: event.args.checkpointId,
      signerSetRoot: event.args.signerSetRoot,
      threshold: event.args.threshold,
      submitter: event.args.submitter,
      signers: [...event.args.signers],
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })

    await context.db.update(signerSyncModule, { address: module }).set({
      hasAppliedCheckpoint: true,
      lastAppliedCheckpoint: event.args.checkpointId,
      lastSyncedBlock: event.block.number,
      lastSyncedTimestamp: event.block.timestamp,
      lastSyncedTxHash: event.transaction.hash,
    })

    await revalidateNetwork(row.instanceId)
  }
)

ponder.on(
  'governedSignerSyncModule:SignerSyncPausedUpdated',
  async ({ event, context }) => {
    const module = event.log.address
    // Out-of-universe guard: find before update — a pause flip on a module whose configuration predates
    // the start block must log-and-skip (the row is not reconstructible without the deployer
    // event), not wedge the indexer on a bare update.
    const row = await context.db.find(signerSyncModule, { address: module })
    if (!row) {
      console.warn(
        `signer-sync: pause update on unobserved module ${module} (configured before the start block?) — skipping`
      )
      return
    }
    await context.db
      .update(signerSyncModule, { address: module })
      .set({ paused: event.args.paused })
    await revalidateNetwork(row.instanceId)
  }
)
