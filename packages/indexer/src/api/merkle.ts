import { Hono } from 'hono'

import { offchainDb } from './db'
import {
  CurrentScoreBlobUnavailableError,
  currentScoreBlobUnavailableBody,
  requireCurrentScoreBlobAvailable,
} from './score-blob-availability'
import {
  ScoreProgramApiError,
  requireEntryScoreProgram,
  requireRowScoreProgram,
  requireSnapshotScoreProgram,
} from './score-programs'
import { getMerkleTreeWithEntries, lower } from './utils'

declare global {
  interface BigInt {
    toJSON: () => string
  }
}

BigInt.prototype.toJSON = function () {
  return this.toString()
}

const merkleApp = new Hono()

/**
 * Resolve the root of the merkle tree.
 * If the root is "current", return the root of the current merkle tree.
 * Otherwise, return the root of the merkle tree with that root. If no such tree exists, throw an error.
 * @param merkleSnapshotContract The contract address of the merkle snapshot.
 * @param root The root of the merkle tree.
 * @returns The resolved root, if found.
 */
const resolveRoot = async (
  merkleSnapshotContract: string,
  root: string
): Promise<string> => {
  if (root === 'current') {
    await requireCurrentScoreBlobAvailable(merkleSnapshotContract)
    const tree = await offchainDb.query.merkleMetadata.findFirst({
      where: (t, { eq }) =>
        eq(
          lower(t.merkleSnapshotContract),
          merkleSnapshotContract.toLowerCase()
        ),
      // Block time is not a unique chain cursor (multiple checkpoints may share
      // a timestamp). Select the canonical latest accepted root by block first.
      orderBy: (t, { desc }) => [desc(t.blockNumber), desc(t.timestamp)],
    })
    if (!tree) {
      throw new Error('Current merkle tree not found')
    }
    return tree.root
  }

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
    throw new Error('Merkle tree not found for root')
  }

  return root
}

merkleApp.get('/:snapshot/all', async (c) => {
  const merkleSnapshotContract = c.req.param('snapshot')
  if (!merkleSnapshotContract) {
    return c.json({ error: 'Merkle snapshot contract is required' }, 400)
  }

  try {
    const current = await requireSnapshotScoreProgram(
      merkleSnapshotContract,
      'merkle'
    )
    const trees = await offchainDb.query.merkleMetadata.findMany({
      where: (t, { eq }) =>
        eq(
          lower(t.merkleSnapshotContract),
          merkleSnapshotContract.toLowerCase()
        ),
      orderBy: (t, { desc }) => [desc(t.blockNumber), desc(t.timestamp)],
    })
    for (const tree of trees) requireRowScoreProgram(tree, current, 'merkle')
    return c.json({ trees, scoreProgram: current })
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return c.json({ error: error.message }, 409)
    }
    throw error
  }
})

merkleApp.get('/:snapshot/:root', async (c) => {
  const merkleSnapshotContract = c.req.param('snapshot')
  if (!merkleSnapshotContract) {
    return c.json({ error: 'Merkle snapshot contract is required' }, 400)
  }

  let { root } = c.req.param()
  if (!root) {
    return c.json({ error: 'Root is required' }, 400)
  }

  try {
    root = await resolveRoot(merkleSnapshotContract, root)
  } catch (error: any) {
    if (error instanceof CurrentScoreBlobUnavailableError) {
      return c.json(currentScoreBlobUnavailableBody(error), 503)
    }
    return c.json({ error: error.message }, 404)
  }

  try {
    const current = await requireSnapshotScoreProgram(
      merkleSnapshotContract,
      'merkle'
    )
    const treeWithEntries = await getMerkleTreeWithEntries(
      merkleSnapshotContract,
      root
    )
    if (!treeWithEntries) {
      return c.json({ error: 'Merkle tree not found' }, 404)
    }
    const scoreProgram = requireRowScoreProgram(
      treeWithEntries.tree,
      current,
      'merkle'
    )
    for (const entry of treeWithEntries.entries) {
      requireEntryScoreProgram(entry, current)
    }
    return c.json({ ...treeWithEntries, scoreProgram })
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return c.json({ error: error.message }, 409)
    }
    throw error
  }
})

merkleApp.get('/:snapshot/:root/:account', async (c) => {
  const merkleSnapshotContract = c.req.param('snapshot')
  if (!merkleSnapshotContract) {
    return c.json({ error: 'Merkle snapshot contract is required' }, 400)
  }

  let { root, account } = c.req.param()
  if (!root || !account) {
    return c.json({ error: 'Root and account are required' }, 400)
  }

  try {
    root = await resolveRoot(merkleSnapshotContract, root)
  } catch (error: any) {
    if (error instanceof CurrentScoreBlobUnavailableError) {
      return c.json(currentScoreBlobUnavailableBody(error), 503)
    }
    return c.json({ error: error.message }, 404)
  }

  const entry = await offchainDb.query.merkleEntry.findFirst({
    columns: {
      account: true,
      value: true,
      proof: true,
      programId: true,
      outputDomain: true,
    },
    where: (t, { and, eq }) =>
      and(
        eq(
          lower(t.merkleSnapshotContract),
          merkleSnapshotContract.toLowerCase()
        ),
        eq(lower(t.root), root.toLowerCase()),
        eq(lower(t.account), account.toLowerCase())
      ),
  })
  if (!entry) {
    return c.json({ error: 'Merkle entry not found' }, 404)
  }
  try {
    const current = await requireSnapshotScoreProgram(
      merkleSnapshotContract,
      'merkle'
    )
    const tree = await offchainDb.query.merkleMetadata.findFirst({
      where: (t, { and, eq }) =>
        and(
          eq(
            lower(t.merkleSnapshotContract),
            merkleSnapshotContract.toLowerCase()
          ),
          eq(lower(t.root), root.toLowerCase())
        ),
    })
    if (!tree) return c.json({ error: 'Merkle tree not found' }, 404)
    const scoreProgram = requireRowScoreProgram(tree, current, 'merkle')
    requireEntryScoreProgram(entry, current)
    return c.json({ entry, scoreProgram })
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return c.json({ error: error.message }, 409)
    }
    throw error
  }
})

export default merkleApp
