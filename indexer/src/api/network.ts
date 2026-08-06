import { and, asc, count, desc, eq, gt, inArray, ne, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from 'ponder:api'
import {
  accumulatorRecord,
  easAttestation,
  instance,
  merkleSnapshot,
  proofSubmission,
  snapshotTrigger,
} from 'ponder:schema'
import { Hex } from 'viem'

import { offchainDb } from './db'
import { EAS_NETWORKS as NETWORKS, isHexEqual, lower } from './utils'

const app = new Hono()

// Get the accounts and attestations that are part of the network defined by the Merkle Snapshot contract.
/**
 * The vouch schema UIDs to attribute attestations to, for one snapshot.
 *
 * Two sources, in order: the build-time config (hand-deployed networks, and the program-tagged
 * entries this route deliberately ignores), then the `instance` table — the catalog of everything
 * `TrustGraphFactory` created. Without the second lookup a factory network 404s here, which is not
 * a cosmetic failure: it is exactly the endpoint the network page reads its member list and
 * attestation feed from, so a freshly created community would render its name and a vouch button
 * over a permanently empty roster.
 */
const schemaUidsForSnapshot = async (
  merkleSnapshotContract: string
): Promise<Hex[] | null> => {
  const configured = NETWORKS.find((network) =>
    isHexEqual(network.contracts.merkleSnapshot, merkleSnapshotContract)
  )
  // `demo:govern` adds presentation/governance data for the factory-created
  // demo to the static catalog before it knows the instance schema. An empty
  // `schemas` array is therefore not an authoritative "no schemas" result:
  // fall through to the on-chain factory catalog, or every indexed vouch is
  // excluded by the empty `inArray` below and the graph appears blank.
  if (configured && configured.schemas.length > 0) {
    return configured.schemas.map((schema) => schema.uid as Hex)
  }

  const row = await db
    .select({ schemaUid: instance.schemaUid })
    .from(instance)
    .where(eq(instance.snapshot, merkleSnapshotContract.toLowerCase() as Hex))
    .limit(1)
  return row.length > 0 ? [row[0]!.schemaUid as Hex] : null
}

app.get('/:snapshot', async (c) => {
  const merkleSnapshotContract = c.req.param('snapshot')
  const schemaUids = await schemaUidsForSnapshot(merkleSnapshotContract)
  if (!schemaUids) {
    return c.json(
      { error: 'Network not found for MerkleSnapshot contract' },
      404
    )
  }

  try {
    const latestMerkleTree = await offchainDb.query.merkleMetadata.findFirst({
      where: (t, { eq }) =>
        eq(
          lower(t.merkleSnapshotContract),
          merkleSnapshotContract.toLowerCase()
        ),
      orderBy: (t, { desc }) => desc(t.timestamp),
    })
    if (!latestMerkleTree) {
      return c.json({ error: 'Merkle tree not found' }, 404)
    }

    const allAccounts = await offchainDb.query.merkleEntry.findMany({
      columns: {
        account: true,
        value: true,
      },
      where: (t, { eq, gt, and }) =>
        and(
          eq(
            lower(t.merkleSnapshotContract),
            merkleSnapshotContract.toLowerCase()
          ),
          eq(lower(t.root), latestMerkleTree.root.toLowerCase()),
          gt(t.value, 0n)
        ),
      orderBy: (t, { asc }) => asc(t.account),
    })

    // Map of in-network accounts to their metadata.
    const accountsMap: Map<
      string,
      {
        value: bigint
        sent: number
        received: number
      }
    > = new Map()
    for (const account of allAccounts) {
      accountsMap.set(account.account, {
        value: account.value,
        sent: 0,
        received: 0,
      })
    }

    const relevantAccounts = Array.from(accountsMap.keys()) as `0x${string}`[]
    const attestations = await db
      .selectDistinctOn([easAttestation.attester, easAttestation.recipient])
      .from(easAttestation)
      .where(
        and(
          // Only include non-revoked attestations.
          eq(easAttestation.revocationTime, 0n),
          // Ignore self-attestations.
          ne(easAttestation.attester, easAttestation.recipient),
          // Only include attestations between in-network accounts.
          inArray(easAttestation.attester, relevantAccounts),
          inArray(easAttestation.recipient, relevantAccounts),
          // Only include attestations for network schemas.
          inArray(easAttestation.schema, schemaUids)
        )
      )
      .orderBy(
        // Same order as distinct columns.
        asc(easAttestation.attester),
        asc(easAttestation.recipient),
        // Newest attestations override older ones, so pick newer first.
        desc(easAttestation.timestamp)
      )

    for (const attestation of attestations) {
      accountsMap.get(attestation.attester)!.sent++
      accountsMap.get(attestation.recipient)!.received++
    }

    const accounts = Array.from(accountsMap)
      .map(([account, { value, sent, received }]) => ({
        account,
        value: value.toString(),
        sent,
        received,
      }))
      .sort((a, b) => a.account.localeCompare(b.account))

    return c.json({
      accounts,
      attestations,
    })
  } catch (error) {
    console.error('Error fetching network:', error)
    return c.json({ error: 'Failed to fetch network' }, 500)
  }
})

/**
 * The pending-score state the app shows between "attestation saved" and "scores updated": the
 * last landed update, whether a recount is running right now, and how many attestations await the
 * next one. Read from chain events alone (SnapshotTriggered / MerkleProofSubmitted / the
 * accumulator's fold markers), never from an operator's self-report — any prover's work produces
 * the same states.
 */
app.get('/:snapshot/status', async (c) => {
  const snapshot = c.req.param('snapshot').toLowerCase() as Hex

  try {
    const [lastRoot] = await db
      .select({
        root: merkleSnapshot.root,
        blockNumber: merkleSnapshot.blockNumber,
        timestamp: merkleSnapshot.timestamp,
      })
      .from(merkleSnapshot)
      .where(eq(merkleSnapshot.address, snapshot))
      .orderBy(desc(merkleSnapshot.blockNumber))
      .limit(1)

    const [lastProof] = await db
      .select()
      .from(proofSubmission)
      .where(eq(proofSubmission.snapshot, snapshot))
      .orderBy(desc(proofSubmission.checkpointId))
      .limit(1)

    const [lastTrigger] = await db
      .select()
      .from(snapshotTrigger)
      .where(eq(snapshotTrigger.snapshot, snapshot))
      .orderBy(desc(snapshotTrigger.checkpointId))
      .limit(1)

    // A trigger newer than the last applied proof means inputs are frozen and a proof is being
    // computed (or owed). With no proof at all, any trigger means the first recount is running.
    const recounting =
      lastTrigger &&
      (!lastProof || lastTrigger.checkpointId > lastProof.checkpointId)
        ? lastTrigger
        : null

    // Folds past the applied checkpoint's freeze boundary are attestations the served scores do
    // not include yet. Needs the network's accumulator: the build-time config first (hand-deployed
    // networks carry `easIndexerResolver`), then the factory catalog — the same two sources as
    // `schemaUidsForSnapshot`, in the same order.
    let pendingAttestations: number | null = null
    const configured = NETWORKS.find((network) =>
      isHexEqual(network.contracts.merkleSnapshot, snapshot)
    )
    const resolver =
      (configured?.contracts as { easIndexerResolver?: string } | undefined)
        ?.easIndexerResolver ??
      (
        await db
          .select({ resolver: instance.resolver })
          .from(instance)
          .where(eq(instance.snapshot, snapshot))
          .limit(1)
      )[0]?.resolver

    if (resolver) {
      // The boundary is the applied checkpoint's own trigger row. A proof whose trigger predates
      // the indexer's start has no boundary to count from, so the count stays null rather than
      // guessing.
      const boundary = lastProof
        ? lastProof.checkpointId === lastTrigger?.checkpointId
          ? lastTrigger
          : (
              await db
                .select()
                .from(snapshotTrigger)
                .where(
                  and(
                    eq(snapshotTrigger.snapshot, snapshot),
                    eq(snapshotTrigger.checkpointId, lastProof.checkpointId)
                  )
                )
                .limit(1)
            )[0]
        : undefined

      if (!lastProof || boundary) {
        const [pending] = await db
          .select({ value: count() })
          .from(accumulatorRecord)
          .where(
            and(
              eq(accumulatorRecord.accumulator, resolver.toLowerCase() as Hex),
              boundary
                ? or(
                    gt(accumulatorRecord.blockNumber, boundary.blockNumber),
                    and(
                      eq(accumulatorRecord.blockNumber, boundary.blockNumber),
                      gt(accumulatorRecord.logIndex, boundary.logIndex)
                    )
                  )
                : undefined
            )
          )
        pendingAttestations = pending?.value ?? null
      }
    }

    return c.json({
      lastUpdate: lastRoot
        ? {
            root: lastRoot.root,
            timestamp: Number(lastRoot.timestamp),
            blockNumber: lastRoot.blockNumber.toString(),
            checkpointId: lastProof ? lastProof.checkpointId.toString() : null,
          }
        : null,
      recounting: recounting
        ? {
            checkpointId: recounting.checkpointId.toString(),
            since: Number(recounting.timestamp),
          }
        : null,
      pendingAttestations,
    })
  } catch (error) {
    console.error('Error fetching network status:', error)
    return c.json({ error: 'Failed to fetch network status' }, 500)
  }
})

export default app
