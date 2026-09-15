import { eq } from 'drizzle-orm'
import { db } from 'ponder:api'
import { instance, weightedPriorInstance } from 'ponder:schema'
import { Hex } from 'viem'

import { EAS_NETWORKS as NETWORKS, isHexEqual } from './utils'

/**
 * The vouch schema UIDs to attribute attestations to, for one snapshot.
 *
 * Three sources, in order: the build-time config (hand-deployed networks, and the program-tagged
 * entries the vouch routes deliberately ignore), then the ordinary and isolated weighted instance
 * catalogs. Without both catalog lookups a factory network is invisible to every route that asks,
 * which is not a cosmetic failure: the network page reads its member list and attestation feed
 * through this, and the account page its memberships. Mainnet's static catalog is empty, so every
 * mainnet network is a factory network.
 */
export const schemaUidsForSnapshot = async (
  merkleSnapshotContract: string
): Promise<Hex[] | null> => {
  const configured = NETWORKS.find((network) =>
    isHexEqual(network.contracts.merkleSnapshot, merkleSnapshotContract)
  )
  // `demo:govern` adds presentation/governance data for the factory-created
  // demo to the static catalog before it knows the instance schema. An empty
  // `schemas` array is therefore not an authoritative "no schemas" result:
  // fall through to the on-chain factory catalog, or every indexed vouch is
  // excluded by an empty `inArray` and the graph appears blank.
  if (configured && configured.schemas.length > 0) {
    return configured.schemas.map((schema) => schema.uid as Hex)
  }

  const [row] = await db
    .select({ schemaUid: instance.schemaUid })
    .from(instance)
    .where(eq(instance.snapshot, merkleSnapshotContract.toLowerCase() as Hex))
    .limit(1)
  if (row) return [row.schemaUid as Hex]

  const [weighted] = await db
    .select({ schemaUid: weightedPriorInstance.schemaUid })
    .from(weightedPriorInstance)
    .where(
      eq(
        weightedPriorInstance.snapshot,
        merkleSnapshotContract.toLowerCase() as Hex
      )
    )
    .limit(1)
  return weighted ? [weighted.schemaUid as Hex] : null
}

/** Resolve the lane-1 fold log for config-backed and factory-created networks alike. */
export const resolverForSnapshot = async (
  snapshot: string
): Promise<Hex | null> => {
  const configured = NETWORKS.find((network) =>
    isHexEqual(network.contracts.merkleSnapshot, snapshot)
  )
  const configuredResolver = (
    configured?.contracts as { easIndexerResolver?: string } | undefined
  )?.easIndexerResolver
  if (configuredResolver) return configuredResolver.toLowerCase() as Hex

  const [row] = await db
    .select({ resolver: instance.resolver })
    .from(instance)
    .where(eq(instance.snapshot, snapshot.toLowerCase() as Hex))
    .limit(1)
  if (row) return row.resolver as Hex

  const [weighted] = await db
    .select({ resolver: weightedPriorInstance.resolver })
    .from(weightedPriorInstance)
    .where(eq(weightedPriorInstance.snapshot, snapshot.toLowerCase() as Hex))
    .limit(1)
  return (weighted?.resolver as Hex | undefined) ?? null
}

/**
 * The configured validation threshold, in whole tokens. Factory networks have none, which is the
 * 0 the frontend's runtime catalog gives them too.
 */
export const validatedThresholdForSnapshot = (snapshot: string): number =>
  NETWORKS.find((network) =>
    isHexEqual(network.contracts.merkleSnapshot, snapshot)
  )?.validatedThreshold ?? 0
