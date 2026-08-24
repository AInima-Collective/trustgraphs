import { inArray } from 'drizzle-orm'
import { db } from 'ponder:api'
import { merkleSnapshot } from 'ponder:schema'

import { offchainDb } from './db'

export class CurrentScoreBlobUnavailableError extends Error {
  readonly status = 503

  constructor(
    readonly ingestion: {
      root: string
      ipfsHashCid: string
      attempts: number
      nextAttemptBlock: bigint | null
      lastError: string | null
    }
  ) {
    super(
      `The latest accepted score root is waiting for its committed IPFS bytes (${ingestion.ipfsHashCid}).`
    )
  }
}

/** Refuse to mislabel an older available tree as "current" while the chain's latest root retries. */
export const requireCurrentScoreBlobAvailable = async (snapshot: string) => {
  const candidates = await offchainDb.query.scoreBlobIngestion.findMany({
    where: (t, { eq }) => eq(t.merkleSnapshotContract, snapshot.toLowerCase()),
    orderBy: (t, { desc }) => [desc(t.blockNumber), desc(t.logIndex)],
    limit: 100,
  })
  const canonicalIds =
    candidates.length === 0
      ? new Set<string>()
      : new Set(
          (
            await db
              .select({ id: merkleSnapshot.id })
              .from(merkleSnapshot)
              .where(
                inArray(
                  merkleSnapshot.id,
                  candidates.map((candidate) => candidate.id)
                )
              )
          ).map((row) => row.id)
        )
  const latest =
    candidates.find((candidate) => canonicalIds.has(candidate.id)) ?? null
  if (latest?.status === 'pending') {
    throw new CurrentScoreBlobUnavailableError({
      root: latest.root,
      ipfsHashCid: latest.ipfsHashCid,
      attempts: latest.attempts,
      nextAttemptBlock: latest.nextAttemptBlock,
      lastError: latest.lastError,
    })
  }
  return latest ?? null
}

export const currentScoreBlobUnavailableBody = (
  error: CurrentScoreBlobUnavailableError
) => ({
  error: error.message,
  availability: {
    status: 'pending',
    ...error.ingestion,
    nextAttemptBlock: error.ingestion.nextAttemptBlock?.toString() ?? null,
  },
})
