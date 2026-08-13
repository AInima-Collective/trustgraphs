import { ponder } from 'ponder:registry'
import { instance, parameterVersion } from 'ponder:schema'
import { type Hex } from 'viem'

import { normalizeInstanceParams } from './factory'
import { revalidateNetwork } from './utils'
import { merkleSnapshotAbi } from '../../frontend/lib/contract-abis'
import {
  instanceRegistryParamsAbi,
  trustgraphsParamsControllerAbi,
} from '../abis/trustgraphsParamsController'

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * Read the controller, snapshot and registry at the event block and require one coherent current
 * version. Returning a diagnosis instead of throwing keeps one malformed instance from pausing
 * Ponder for every healthy network.
 */
const readLiveController = async (context: any, controller: Hex) => {
  try {
    const [instanceId, snapshot, registry, version, controllerHash, params] =
      await Promise.all([
        context.client.readContract({
          address: controller,
          abi: trustgraphsParamsControllerAbi,
          functionName: 'instanceId',
        }),
        context.client.readContract({
          address: controller,
          abi: trustgraphsParamsControllerAbi,
          functionName: 'snapshot',
        }),
        context.client.readContract({
          address: controller,
          abi: trustgraphsParamsControllerAbi,
          functionName: 'registry',
        }),
        context.client.readContract({
          address: controller,
          abi: trustgraphsParamsControllerAbi,
          functionName: 'version',
        }),
        context.client.readContract({
          address: controller,
          abi: trustgraphsParamsControllerAbi,
          functionName: 'currentParamsHash',
        }),
        context.client.readContract({
          address: controller,
          abi: trustgraphsParamsControllerAbi,
          functionName: 'getCurrentParams',
        }),
      ])
    const [
      { paramsJson, trustedSeeds, hash },
      snapshotHash,
      record,
      authority,
    ] = await Promise.all([
      Promise.resolve(normalizeInstanceParams(params)),
      context.client.readContract({
        address: snapshot,
        abi: merkleSnapshotAbi,
        functionName: 'paramsHash',
      }),
      context.client.readContract({
        address: registry,
        abi: instanceRegistryParamsAbi,
        functionName: 'getInstance',
        args: [instanceId],
      }),
      context.client.readContract({
        address: registry,
        abi: instanceRegistryParamsAbi,
        functionName: 'paramsAuthority',
        args: [instanceId],
      }),
    ])

    const failures: string[] = []
    if (!sameHex(hash, controllerHash))
      failures.push(`encoded ${hash} != controller ${controllerHash}`)
    if (!sameHex(hash, snapshotHash))
      failures.push(`encoded ${hash} != snapshot ${snapshotHash}`)
    if (!sameHex(hash, record.paramsHash))
      failures.push(`encoded ${hash} != registry ${record.paramsHash}`)
    if (!sameHex(snapshot, record.snapshot))
      failures.push(
        `controller snapshot ${snapshot} != registry ${record.snapshot}`
      )
    if (!sameHex(authority, controller))
      failures.push(
        `registry authority ${authority} != controller ${controller}`
      )

    return {
      ok: failures.length === 0,
      reason: failures.join('; ') || null,
      instanceId,
      snapshot,
      registry,
      version,
      hash,
      params,
      paramsJson,
      trustedSeeds,
    }
  } catch (error) {
    return {
      ok: false as const,
      reason: `controller consistency read failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}

const onParamsUpdated = async ({ event, context }: any) => {
  const {
    instanceId,
    version,
    paramsHash,
    previousParamsHash,
    params,
    evidenceURI,
  } = event.args
  const controller = event.log.address
  const normalized = normalizeInstanceParams(params)
  const live = await readLiveController(context, controller)
  const failures: string[] = []
  if (!sameHex(normalized.hash, paramsHash)) {
    failures.push(
      `event tuple encodes ${normalized.hash}, event names ${paramsHash}`
    )
  }
  if (!live.ok) failures.push(live.reason ?? 'controller is inconsistent')
  if (live.ok) {
    if (!sameHex(live.instanceId, instanceId))
      failures.push(
        `controller instance ${live.instanceId} != event ${instanceId}`
      )
    if (live.version !== version)
      failures.push(`controller version ${live.version} != event ${version}`)
    if (!sameHex(live.hash, paramsHash))
      failures.push(`controller hash ${live.hash} != event ${paramsHash}`)
  }
  const valid = failures.length === 0
  const invalidReason = failures.join('; ') || null

  await context.db
    .insert(parameterVersion)
    .values({
      id: `${instanceId}-${version}`,
      instanceId,
      controller,
      version,
      paramsHash,
      previousParamsHash,
      params: normalized.paramsJson,
      trustedSeeds: normalized.trustedSeeds,
      evidenceURI,
      executor: event.transaction.from,
      executedAtBlock: event.block.number,
      executedTimestamp: event.block.timestamp,
      executedTxHash: event.transaction.hash,
      firstCheckpoint: null,
      firstCheckpointBlock: null,
      firstCheckpointTimestamp: null,
      firstCheckpointTxHash: null,
      valid,
      invalidReason,
    })
    .onConflictDoNothing()

  const existing = await context.db.find(instance, { id: instanceId })
  if (valid && existing) {
    await context.db.update(instance, { id: instanceId }).set({
      paramsController: controller,
      paramsVersion: version,
      paramsHash,
      params: normalized.paramsJson,
      trustedSeeds: normalized.trustedSeeds,
      paramsExecutedAtBlock: event.block.number,
      paramsExecutedTimestamp: event.block.timestamp,
      paramsExecutedTxHash: event.transaction.hash,
      paramsFirstCheckpoint: null,
    })
    await revalidateNetwork()
  } else if (!valid) {
    console.error(
      `params: refusing inconsistent version ${instanceId} v${version}: ${invalidReason}`
    )
  }
}

ponder.on('trustgraphsParamsController:ParamsUpdated', onParamsUpdated)
ponder.on('migratedTrustgraphsParamsController:ParamsUpdated', onParamsUpdated)

// The discovery event follows InstanceCreated and precedes the controller's explicit version-1
// publication, so ordered indexers know both the catalog row and child address before history lands.
ponder.on(
  'trustgraphsFactory:ParamsControllerCreated',
  async ({ event, context }) => {
    const { instanceId, controller } = event.args
    const live = await readLiveController(context, controller)
    if (!live.ok || !live.instanceId || !sameHex(live.instanceId, instanceId)) {
      console.error(
        `params: refusing controller discovery ${instanceId} -> ${controller}: ${
          live.reason ?? 'instance id mismatch'
        }`
      )
      return
    }
    const history = await context.db.find(parameterVersion, {
      id: `${instanceId}-${live.version}`,
    })
    await context.db.update(instance, { id: instanceId }).set({
      paramsController: controller,
      paramsVersion: live.version,
      paramsHash: live.hash,
      params: live.paramsJson,
      trustedSeeds: live.trustedSeeds,
      paramsExecutedAtBlock: history?.executedAtBlock ?? event.block.number,
      paramsExecutedTimestamp:
        history?.executedTimestamp ?? event.block.timestamp,
      paramsExecutedTxHash: history?.executedTxHash ?? event.transaction.hash,
      paramsFirstCheckpoint: history?.firstCheckpoint ?? null,
    })
    await revalidateNetwork()
  }
)
