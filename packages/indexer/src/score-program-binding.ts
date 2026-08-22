import { and, desc, eq } from 'drizzle-orm'
import { ponder } from 'ponder:registry'
import { scoreProgramBinding, scoreProgramBindingEvent } from 'ponder:schema'

import {
  type ScoreProgramProvenance,
  requireScoreProgram,
  scoreProgramById,
} from './score-program'
import {
  decideParamsHashRotation,
  decideScoreBinding,
} from './score-program-binding-state'
import { merkleSnapshotAbi } from '../../frontend/lib/contract-abis'

export const scoreBindingId = (chainId: string | number, snapshot: string) =>
  `${chainId}:${snapshot.toLowerCase()}`

type RegistryEventArgs = {
  instanceId: `0x${string}`
  program: `0x${string}`
  snapshot: `0x${string}`
  verifier: `0x${string}`
  registryOrAccumulator: `0x${string}`
  paramsHash: `0x${string}`
}

type ParamsHashEventArgs = {
  instanceId: `0x${string}`
  oldParamsHash: `0x${string}`
  newParamsHash: `0x${string}`
}

/**
 * Fold an authenticated InstanceRegistry event into an immutable snapshot identity. Updates may
 * refresh other registry fields, but they may never reinterpret a snapshot as another program.
 */
const recordBinding = async (
  event: any,
  context: any,
  sourceKind: 'instance-registered' | 'instance-updated'
) => {
  const args = event.args as RegistryEventArgs
  const chainId = `${context.chain.id}`
  const id = scoreBindingId(chainId, args.snapshot)
  const definition = scoreProgramById(args.program)
  const [existing] = await context.db.sql
    .select()
    .from(scoreProgramBinding)
    .where(eq(scoreProgramBinding.id, id))
    .limit(1)

  const { accepted, reason } = decideScoreBinding(existing, {
    snapshot: args.snapshot,
    instanceId: args.instanceId,
    programId: args.program,
    outputDomain: definition?.outputDomain ?? null,
  })

  if (!existing) {
    await context.db.insert(scoreProgramBinding).values({
      id,
      chainId,
      snapshot: args.snapshot,
      instanceId: args.instanceId,
      programId: args.program,
      outputDomain: definition?.outputDomain ?? null,
      programName: definition?.name ?? null,
      keyEncoding: definition?.keyEncoding ?? null,
      ingestion: definition?.ingestion ?? null,
      verifier: args.verifier,
      registryOrAccumulator: args.registryOrAccumulator,
      paramsHash: args.paramsHash,
      sourceRegistry: event.log.address,
      sourceKind,
      sourceBlock: event.block.number,
      sourceLogIndex: event.log.logIndex,
      sourceTxHash: event.transaction.hash,
      conflict: !accepted,
      conflictReason: reason,
    })
  } else if (!accepted && !existing.conflict) {
    // Preserve the first accepted identity and its provenance; only add the conflict marker. The
    // append-only event row below carries the competing tuple for audit.
    await context.db.update(scoreProgramBinding, { id }).set({
      conflict: true,
      conflictReason: reason,
    })
  } else if (accepted && existing && sourceKind === 'instance-updated') {
    // Same immutable identity, refreshed verifier/params provenance. During replay, roots before
    // this log see the old row and roots after it see this one.
    await context.db.update(scoreProgramBinding, { id }).set({
      verifier: args.verifier,
      registryOrAccumulator: args.registryOrAccumulator,
      paramsHash: args.paramsHash,
      sourceKind,
      sourceBlock: event.block.number,
      sourceLogIndex: event.log.logIndex,
      sourceTxHash: event.transaction.hash,
    })
  }

  await context.db.insert(scoreProgramBindingEvent).values({
    id: event.id,
    bindingId: id,
    chainId,
    snapshot: args.snapshot,
    instanceId: args.instanceId,
    programId: args.program,
    outputDomain: definition?.outputDomain ?? null,
    verifier: args.verifier,
    registryOrAccumulator: args.registryOrAccumulator,
    paramsHash: args.paramsHash,
    sourceRegistry: event.log.address,
    sourceKind,
    accepted,
    reason,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  })
}

ponder.on('instanceRegistry:InstanceRegistered', async ({ event, context }) =>
  recordBinding(event, context, 'instance-registered')
)

ponder.on('instanceRegistry:InstanceUpdated', async ({ event, context }) =>
  recordBinding(event, context, 'instance-updated')
)

/** Keep the authenticated tuple current when the restricted params authority rotates its hash. */
ponder.on(
  'instanceRegistry:InstanceParamsHashUpdated',
  async ({ event, context }) => {
    const args = event.args as ParamsHashEventArgs
    const chainId = `${context.chain.id}`
    // An InstanceUpdated may move an instance id to a new snapshot. Only the newest binding is the
    // registry's current row; older snapshots retain their historical provenance unchanged.
    const [binding] = await context.db.sql
      .select()
      .from(scoreProgramBinding)
      .where(
        and(
          eq(scoreProgramBinding.chainId, chainId),
          eq(scoreProgramBinding.instanceId, args.instanceId)
        )
      )
      .orderBy(
        desc(scoreProgramBinding.sourceBlock),
        desc(scoreProgramBinding.sourceLogIndex)
      )
      .limit(1)
    if (!binding) {
      // M0 hazard sweep: a params-hash rotation for an instance whose registration predates the
      // start block is out-of-universe. The fold is event-sourced provenance — synthesizing a
      // binding from current chain state would forge history — so log and skip (there is no
      // binding id to hang even a receipt on), and never wedge the indexer on a valid chain.
      console.warn(
        `score binding: params-hash update for unobserved instance ${args.instanceId} (registered before the start block?) — skipping`
      )
      return
    }

    const { accepted, reason } = decideParamsHashRotation(
      binding,
      args.oldParamsHash
    )

    if (accepted) {
      await context.db.update(scoreProgramBinding, { id: binding.id }).set({
        paramsHash: args.newParamsHash,
        sourceRegistry: event.log.address,
        sourceKind: 'instance-params-hash-updated',
        sourceBlock: event.block.number,
        sourceLogIndex: event.log.logIndex,
        sourceTxHash: event.transaction.hash,
      })
    } else if (!binding.conflict) {
      await context.db.update(scoreProgramBinding, { id: binding.id }).set({
        conflict: true,
        conflictReason: reason,
      })
    }

    await context.db.insert(scoreProgramBindingEvent).values({
      id: event.id,
      bindingId: binding.id,
      chainId,
      snapshot: binding.snapshot,
      instanceId: args.instanceId,
      programId: binding.programId,
      outputDomain: binding.outputDomain,
      verifier: binding.verifier,
      registryOrAccumulator: binding.registryOrAccumulator,
      paramsHash: args.newParamsHash,
      sourceRegistry: event.log.address,
      sourceKind: 'instance-params-hash-updated',
      accepted,
      reason,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
  }
)

/** Resolve and verify the declaration before fetching or parsing an untrusted score blob. */
export const requireAuthenticatedScoreBinding = async (
  context: any,
  snapshot: `0x${string}`
) => {
  const id = scoreBindingId(context.chain.id, snapshot)
  const [binding] = await context.db.sql
    .select()
    .from(scoreProgramBinding)
    .where(eq(scoreProgramBinding.id, id))
    .limit(1)
  if (!binding) {
    throw new Error(
      `score ingestion refused: snapshot ${snapshot} has no authenticated InstanceRegistry binding`
    )
  }
  if (binding.conflict) {
    throw new Error(
      `score ingestion refused: snapshot ${snapshot} has a conflicting binding (${binding.conflictReason})`
    )
  }
  if (!binding.outputDomain || !binding.programName || !binding.keyEncoding) {
    throw new Error(
      `score ingestion refused: snapshot ${snapshot} uses unknown program ${binding.programId}`
    )
  }

  const program = requireScoreProgram(binding.programId, binding.outputDomain)
  const snapshotVerifier = (await context.client.readContract({
    address: snapshot,
    abi: merkleSnapshotAbi,
    functionName: 'zkVerifier',
  })) as `0x${string}`
  if (snapshotVerifier.toLowerCase() !== binding.verifier.toLowerCase()) {
    throw new Error(
      `score ingestion refused: snapshot verifier ${snapshotVerifier} does not match registry verifier ${binding.verifier}`
    )
  }

  const provenance: ScoreProgramProvenance = {
    programId: binding.programId,
    programName: program.name,
    outputDomain: binding.outputDomain,
    outputDomainName: program.outputDomainName,
    keyEncoding: program.keyEncoding,
    instanceId: binding.instanceId,
    verifier: binding.verifier,
    registryOrAccumulator: binding.registryOrAccumulator,
    paramsHash: binding.paramsHash,
    source: {
      kind: binding.sourceKind,
      registry: binding.sourceRegistry,
      blockNumber: binding.sourceBlock.toString(),
      logIndex: binding.sourceLogIndex,
      transactionHash: binding.sourceTxHash,
    },
  }
  return { binding, program, provenance }
}
