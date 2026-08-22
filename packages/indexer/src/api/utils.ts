import { SQL, sql } from 'drizzle-orm'
import { AnyPgColumn } from 'drizzle-orm/pg-core'

import { offchainDb } from './db'
import { AnyNetwork, Network } from '../../../frontend/lib/types'
import networksJson from '../../networks.json'
import * as offchainSchema from '../../offchain.schema'

/**
 * The trust-graph (EAS, address-keyed) networks from the generated catalog. Typed explicitly and
 * filtered here so typechecking doesn't depend on the box-local JSON shape: a
 * `program: "hypercerts"` entry has no schemas/pagerank config and is served by its own
 * /hypercerts routes, and a `program: "contributions"` entry (no easIndexerResolver, no pagerank
 * config) is served by /contributions — neither belongs to the vouch-network routes.
 */
export const EAS_NETWORKS = (networksJson as AnyNetwork[]).filter(
  (network): network is Network =>
    network.program !== 'hypercerts' &&
    (network.program as string | undefined) !== 'contributions'
)

export const lower = (column: AnyPgColumn): SQL => sql`lower(${column})`

/**
 * Check if two hex values are equal.
 *
 * @param hex1 - The first hex value.
 * @param hex2 - The second hex value.
 * @returns True if the hex values are equal, false otherwise.
 */
export const isHexEqual = (hex1: string, hex2: string) =>
  hex1.toLowerCase() === hex2.toLowerCase()

export type MerkleTreeWithEntries = {
  tree: typeof offchainSchema.merkleMetadata.$inferSelect
  entries: Pick<
    typeof offchainSchema.merkleEntry.$inferSelect,
    'account' | 'value' | 'proof' | 'programId' | 'outputDomain'
  >[]
}

/**
 * Get the merkle tree with its entries (sorted by value descending).
 * @param merkleSnapshotContract The contract address of the merkle snapshot.
 * @param root The root of the merkle tree.
 * @returns The merkle tree with its entries (sorted by value descending) or
 *          null if not found.
 */
export const getMerkleTreeWithEntries = async (
  merkleSnapshotContract: string,
  root: string
): Promise<MerkleTreeWithEntries | null> => {
  const tree = await offchainDb.query.merkleMetadata.findFirst({
    where: (t, { eq, and }) =>
      and(
        eq(
          lower(t.merkleSnapshotContract),
          merkleSnapshotContract.toLowerCase()
        ),
        eq(lower(t.root), root.toLowerCase())
      ),
  })
  if (!tree) {
    return null
  }

  const entries = await offchainDb.query.merkleEntry.findMany({
    columns: {
      account: true,
      value: true,
      proof: true,
      programId: true,
      outputDomain: true,
    },
    where: (t, { eq, and }) =>
      and(
        eq(
          lower(t.merkleSnapshotContract),
          merkleSnapshotContract.toLowerCase()
        ),
        eq(lower(t.root), root.toLowerCase())
      ),
    orderBy: (t, { desc }) => desc(t.value),
  })

  return { tree, entries }
}
