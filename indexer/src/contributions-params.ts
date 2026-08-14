import { ponder } from 'ponder:registry'
import { contributionsParameterVersion } from 'ponder:schema'
import { type Hex } from 'viem'

import {
  contributionsParamsHash,
  normalizeOnchainContributionsParams,
  paramsSnapshot,
} from './contributions-shared'
import { merkleSnapshotAbi } from '../../frontend/lib/contract-abis'
import { contributionsParamsControllerAbi } from '../abis/contributionsParamsController'
import { instanceRegistryParamsAbi } from '../abis/trustgraphsParamsController'

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Persist the full event tuple only after all four public commitment surfaces agree. */
ponder.on(
  'contributionsParamsController:ContributionsParamsUpdated',
  async ({ event, context }) => {
    const {
      instanceId,
      version,
      paramsHash,
      previousParamsHash,
      params: eventParams,
      evidenceURI,
    } = event.args
    const controller = event.log.address
    const params = normalizeOnchainContributionsParams(eventParams)
    const encoded = contributionsParamsHash(params)
    const failures: string[] = []

    let snapshot = '0x0000000000000000000000000000000000000000' as Hex
    let eas = snapshot
    try {
      const [
        liveId,
        liveSnapshot,
        liveEas,
        registry,
        liveVersion,
        liveHash,
        liveParams,
      ] = await Promise.all([
        context.client.readContract({
          address: controller,
          abi: contributionsParamsControllerAbi,
          functionName: 'instanceId',
        }),
        context.client.readContract({
          address: controller,
          abi: contributionsParamsControllerAbi,
          functionName: 'snapshot',
        }),
        context.client.readContract({
          address: controller,
          abi: contributionsParamsControllerAbi,
          functionName: 'eas',
        }),
        context.client.readContract({
          address: controller,
          abi: contributionsParamsControllerAbi,
          functionName: 'registry',
        }),
        context.client.readContract({
          address: controller,
          abi: contributionsParamsControllerAbi,
          functionName: 'version',
        }),
        context.client.readContract({
          address: controller,
          abi: contributionsParamsControllerAbi,
          functionName: 'currentParamsHash',
        }),
        context.client.readContract({
          address: controller,
          abi: contributionsParamsControllerAbi,
          functionName: 'getContributionsParams',
        }),
      ])
      snapshot = liveSnapshot
      eas = liveEas
      const [snapshotHash, record, authority] = await Promise.all([
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
      const getterHash = contributionsParamsHash(
        normalizeOnchainContributionsParams(liveParams)
      )
      if (!sameHex(liveId, instanceId))
        failures.push(`controller instance ${liveId} != event ${instanceId}`)
      if (liveVersion !== version)
        failures.push(`controller version ${liveVersion} != event ${version}`)
      for (const [surface, hash] of [
        ['event', paramsHash],
        ['controller', liveHash],
        ['controller getter', getterHash],
        ['snapshot', snapshotHash],
        ['registry', record.paramsHash],
      ] as const) {
        if (!sameHex(encoded, hash))
          failures.push(`encoded ${encoded} != ${surface} ${hash}`)
      }
      if (!sameHex(record.snapshot, snapshot))
        failures.push(`registry snapshot ${record.snapshot} != ${snapshot}`)
      if (!sameHex(authority, controller))
        failures.push(`registry authority ${authority} != ${controller}`)
    } catch (error) {
      failures.push(
        `controller consistency read failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }

    await context.db
      .insert(contributionsParameterVersion)
      .values({
        id: `${instanceId}-${version}`,
        instanceId,
        controller,
        snapshot,
        eas,
        version,
        paramsHash,
        previousParamsHash,
        params: paramsSnapshot(params),
        trustedSeeds: [...params.trustedSeeds],
        evidenceURI,
        executor: event.transaction.from,
        executedAtBlock: event.block.number,
        executedTimestamp: event.block.timestamp,
        executedTxHash: event.transaction.hash,
        valid: failures.length === 0,
        invalidReason: failures.join('; ') || null,
      })
      .onConflictDoNothing()

    if (failures.length > 0) {
      console.error(
        `contributions params: refusing ${instanceId} v${version}: ${failures.join('; ')}`
      )
    }
  }
)
