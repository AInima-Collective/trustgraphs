import { and, asc, desc, eq, inArray, ne, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { uniqBy } from 'lodash'
import { db } from 'ponder:api'
import {
  accumulatorRecord,
  easAttestation,
  merkleSnapshot,
} from 'ponder:schema'
import { Hex } from 'viem'

import {
  ScoreProgramApiError,
  requireEntryScoreProgram,
  requireRowScoreProgram,
  requireSnapshotScoreProgram,
} from './score-programs'
import {
  MerkleTreeWithEntries,
  EAS_NETWORKS as NETWORKS,
  getMerkleTreeWithEntries,
  isHexEqual,
  lower,
} from './utils'
import type { ScoreProgramProvenance } from '../score-program'
import { currentVouches } from '../trust-reconcile'

export type NetworkProfile = {
  scoreProgram: ScoreProgramProvenance
  /** The chain ID of the merkle snapshot contract. */
  chainId: string
  /** The address of the merkle snapshot contract. */
  merkleSnapshotContract: string
  /** The root of the merkle tree. */
  merkleRoot: string
  /** The IPFS hash of the merkle tree. */
  merkleIpfsHash: string
  /** The rank of this account in the network. 0 if not found. */
  rank: number
  /** The trust score of this account in the network. 0 if not found. */
  score: string
  /** Whether or not this account is validated. */
  validated: boolean
  /** Attestation UIDs given by this account that are counted for the network. */
  attestationsGiven: {
    /** Attestation UIDs sent by this account if it's in the network (only the latest per-recipient is counted). */
    inNetwork: string[]
    /** Attestation UIDs sent by this account if it's out of the network or old duplicates to in-network accounts. */
    outOfNetwork: string[]
  }
  /** Attestation UIDs received by this account by in-network and out-of-network accounts. */
  attestationsReceived: {
    /** Attestation UIDs received by this account from in-network accounts. */
    inNetwork: string[]
    /** Attestation UIDs received by this account from out-of-network accounts (or old duplicates from in-network accounts). */
    outOfNetwork: string[]
  }
}

const app = new Hono()

// Get attestations for an account
app.get('/:account/attestations', async (c) => {
  try {
    const account = c.req.param('account')

    if (!account) {
      return c.json({ error: 'Account parameter is required' }, 400)
    }

    // Get attestations sent or received for the account
    const attestations = await db
      .select()
      .from(easAttestation)
      .where(
        and(
          or(
            eq(easAttestation.attester, account as `0x${string}`),
            eq(easAttestation.recipient, account as `0x${string}`)
          ),
          // not self-attested
          ne(easAttestation.attester, easAttestation.recipient)
        )
      )
      .orderBy(desc(easAttestation.timestamp))

    return c.json({ attestations })
  } catch (error) {
    console.error('Error fetching attestations for account:', error)
    return c.json({ error: 'Failed to fetch attestation counts' }, 500)
  }
})

// Get network profiles for an account
app.get('/:account/networks', async (c) => {
  try {
    const account = c.req.param('account')

    if (!account) {
      return c.json({ error: 'Account parameter is required' }, 400)
    }

    // Get attestations sent or received for the account.
    const attestations = await db
      .select()
      .from(easAttestation)
      .where(
        and(
          // Only include attestations for the account.
          or(
            eq(easAttestation.attester, account as `0x${string}`),
            eq(easAttestation.recipient, account as `0x${string}`)
          ),
          // not self-attested
          ne(easAttestation.attester, easAttestation.recipient)
        )
      )
      .orderBy(desc(easAttestation.timestamp))

    // Get unique network profiles.
    const networks = (
      await Promise.all(
        (
          await db
            .selectDistinctOn([merkleSnapshot.address])
            .from(merkleSnapshot)
            .orderBy(
              asc(merkleSnapshot.address),
              desc(merkleSnapshot.timestamp)
            )
        ).map(async (snapshot): Promise<NetworkProfile | null> => {
          // Find the network that this merkle snapshot contract belongs to.
          const network = NETWORKS.find((network) =>
            isHexEqual(network.contracts.merkleSnapshot, snapshot.address)
          )
          if (!network) {
            return null
          }

          const currentAttestationUids = await currentUidsForResolver(
            network.contracts.easIndexerResolver
          )

          // Get the merkle tree with its entries for the latest merkle root.
          const merkleTreeWithEntries = await getMerkleTreeWithEntries(
            snapshot.address,
            snapshot.root
          )
          if (!merkleTreeWithEntries) {
            return null
          }
          const currentScoreProgram = await requireSnapshotScoreProgram(
            snapshot.address,
            'merkle'
          )
          const scoreProgram = requireRowScoreProgram(
            merkleTreeWithEntries.tree,
            currentScoreProgram,
            'merkle'
          )
          for (const entry of merkleTreeWithEntries.entries) {
            requireEntryScoreProgram(entry, currentScoreProgram)
          }

          return buildNetworkProfile({
            account,
            snapshot,
            merkleTreeWithEntries,
            attestations,
            network,
            currentAttestationUids,
            scoreProgram,
          })
        })
      )
    ).filter((network) => network !== null)

    return c.json({ networks })
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return c.json({ error: error.message }, 409)
    }
    console.error('Error fetching network profiles:', error)
    return c.json({ error: 'Failed to fetch network profiles' }, 500)
  }
})

// Get network profile for an account
app.get('/:account/network/:snapshot', async (c) => {
  try {
    const account = c.req.param('account')
    const snapshotAddress = c.req.param('snapshot')

    if (!account) {
      return c.json({ error: 'Account parameter is required' }, 400)
    }

    if (!snapshotAddress) {
      return c.json({ error: 'Snapshot parameter is required' }, 400)
    }

    // Find the network that this merkle snapshot contract belongs to.
    const network = NETWORKS.find((network) =>
      isHexEqual(network.contracts.merkleSnapshot, snapshotAddress)
    )
    if (!network) {
      return c.json({ error: 'Network not found' }, 404)
    }

    const snapshot = (
      await db
        .selectDistinctOn([merkleSnapshot.address])
        .from(merkleSnapshot)
        .where(eq(lower(merkleSnapshot.address), snapshotAddress.toLowerCase()))
        .orderBy(asc(merkleSnapshot.address), desc(merkleSnapshot.timestamp))
        .limit(1)
    )[0]
    if (!snapshot) {
      return c.json({ error: 'Snapshot not found' }, 404)
    }

    // Get attestations sent or received for the account for network schemas.
    const attestations = await db
      .select()
      .from(easAttestation)
      .where(
        and(
          // Only include attestations for network schemas.
          inArray(
            easAttestation.schema,
            network.schemas.map((schema) => schema.uid as Hex)
          ),
          // Only include attestations for the account.
          or(
            eq(easAttestation.attester, account as `0x${string}`),
            eq(easAttestation.recipient, account as `0x${string}`)
          ),
          // not self-attested
          ne(easAttestation.attester, easAttestation.recipient)
        )
      )
      .orderBy(desc(easAttestation.timestamp))

    // Get the merkle tree with its entries for the latest merkle root.
    const merkleTreeWithEntries = await getMerkleTreeWithEntries(
      snapshot.address,
      snapshot.root
    )
    if (!merkleTreeWithEntries) {
      return c.json({ error: 'Merkle tree not found' }, 404)
    }
    const currentScoreProgram = await requireSnapshotScoreProgram(
      snapshot.address,
      'merkle'
    )
    const scoreProgram = requireRowScoreProgram(
      merkleTreeWithEntries.tree,
      currentScoreProgram,
      'merkle'
    )
    for (const entry of merkleTreeWithEntries.entries) {
      requireEntryScoreProgram(entry, currentScoreProgram)
    }

    const networkProfile = buildNetworkProfile({
      account,
      snapshot,
      merkleTreeWithEntries,
      attestations,
      network,
      currentAttestationUids: await currentUidsForResolver(
        network.contracts.easIndexerResolver
      ),
      scoreProgram,
    })

    return c.json({ network: networkProfile })
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return c.json({ error: error.message }, 409)
    }
    console.error('Error fetching network profile:', error)
    return c.json({ error: 'Failed to fetch network profile' }, 500)
  }
})

export default app

/**
 * Builds a NetworkProfile from the given parameters.
 */
const buildNetworkProfile = ({
  account,
  snapshot,
  merkleTreeWithEntries: { tree, entries },
  attestations,
  network,
  currentAttestationUids,
  scoreProgram,
}: {
  account: string
  snapshot: typeof merkleSnapshot.$inferSelect
  merkleTreeWithEntries: MerkleTreeWithEntries
  attestations: (typeof easAttestation.$inferSelect)[]
  network: (typeof NETWORKS)[number]
  currentAttestationUids: Set<string>
  scoreProgram: ScoreProgramProvenance
}): NetworkProfile => {
  // Set of in-network account addresses.
  const inNetworkAccounts = new Set(
    entries.filter((e) => e.value > 0n).map((e) => e.account.toLowerCase())
  )
  const isInNetwork = inNetworkAccounts.has(account.toLowerCase())

  const rank =
    entries.findIndex((entry) => isHexEqual(entry.account, account)) + 1 || -1

  const score =
    entries
      .find((entry) => isHexEqual(entry.account, account))
      ?.value.toString() || '0'

  const attestationsGiven = attestations
    .filter(
      (attestation) =>
        // Attestation is given by the account.
        isHexEqual(attestation.attester, account) &&
        // Attestation is for a schema that is part of the network.
        network.schemas.some((schema) =>
          isHexEqual(schema.uid, attestation.schema)
        )
    )
    // Sort by timestamp in descending order so the newest attestations are first.
    .sort((a, b) => Number(b.timestamp - a.timestamp))

  // Attestations sent to accounts if this account is in the network (de-duplicated by recipient, the most recent attestation is kept).
  const inNetworkAttestationsGiven = isInNetwork
    ? uniqBy(
        attestationsGiven.filter(
          (attestation) =>
            inNetworkAccounts.has(attestation.recipient.toLowerCase()) &&
            currentAttestationUids.has(attestation.uid.toLowerCase())
        ),
        'recipient'
      ).map((attestation) => attestation.uid)
    : []

  // Attestations sent to accounts if this account is out of the network (or old duplicates to in-network accounts).
  const outOfNetworkAttestationsGiven = attestationsGiven
    .filter(
      (attestation) => !inNetworkAttestationsGiven.includes(attestation.uid)
    )
    .map((attestation) => attestation.uid)

  const attestationsReceived = attestations
    .filter(
      (attestation) =>
        // Attestation is received by the account.
        isHexEqual(attestation.recipient, account) &&
        // Attestation is for a schema that is part of the network.
        network.schemas.some((schema) =>
          isHexEqual(schema.uid, attestation.schema)
        )
    )
    // Sort by timestamp in descending order so the newest attestations are first.
    .sort((a, b) => Number(b.timestamp - a.timestamp))

  // Attestations received from in-network accounts (de-duplicated by attester, the most recent attestation is kept).
  const inNetworkAttestationsReceived = uniqBy(
    attestationsReceived.filter(
      (attestation) =>
        inNetworkAccounts.has(attestation.attester.toLowerCase()) &&
        currentAttestationUids.has(attestation.uid.toLowerCase())
    ),
    'attester'
  ).map((attestation) => attestation.uid)

  // Attestations received from out-of-network accounts (or old duplicates from in-network accounts).
  const outOfNetworkAttestationsReceived = attestationsReceived
    .filter(
      (attestation) => !inNetworkAttestationsReceived.includes(attestation.uid)
    )
    .map((attestation) => attestation.uid)

  return {
    scoreProgram,
    chainId: snapshot.chainId,
    merkleSnapshotContract: snapshot.address,
    merkleRoot: snapshot.root,
    merkleIpfsHash: tree.ipfsHashCid,
    rank,
    score,
    validated: Number(score) >= network.validatedThreshold,
    attestationsGiven: {
      inNetwork: inNetworkAttestationsGiven,
      outOfNetwork: outOfNetworkAttestationsGiven,
    },
    attestationsReceived: {
      inNetwork: inNetworkAttestationsReceived,
      outOfNetwork: outOfNetworkAttestationsReceived,
    },
  }
}

/** The exact current pair state for a trust-graph resolver, derived from accumulator fold order. */
const currentUidsForResolver = async (resolver: string | undefined) => {
  if (!resolver) return new Set<string>()
  const rows = await db
    .select({
      kind: accumulatorRecord.kind,
      attester: accumulatorRecord.attester,
      recipient: accumulatorRecord.recipient,
      uid: accumulatorRecord.uid,
      blockNumber: accumulatorRecord.blockNumber,
      logIndex: accumulatorRecord.logIndex,
    })
    .from(accumulatorRecord)
    .where(
      eq(accumulatorRecord.accumulator, resolver.toLowerCase() as `0x${string}`)
    )
    .orderBy(
      asc(accumulatorRecord.blockNumber),
      asc(accumulatorRecord.logIndex)
    )
  return new Set(currentVouches(rows).map((row) => row.uid.toLowerCase()))
}
