import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ensureMerkleGovModuleRow,
  readMerkleGovModuleRow,
  type MerkleGovModuleRow,
} from './gov-module-shared'

const MODULE = '0x1111111111111111111111111111111111111111' as const

/** Contract state the mock chain serves, keyed by view function name. */
const chainState: Record<string, unknown> = {
  avatar: '0x2222222222222222222222222222222222222222',
  target: '0x3333333333333333333333333333333333333333',
  merkleSnapshotContract: '0x4444444444444444444444444444444444444444',
  currentMerkleRoot: `0x${'ab'.repeat(32)}`,
  ipfsHash: `0x${'cd'.repeat(32)}`,
  ipfsHashCid: 'bafyexamplecid',
  totalVotingPower: 1_000_000n,
  proposalCount: 3n,
  votingDelay: 10n,
  votingPeriod: 100n,
  quorum: 400n,
}

const mockClient = () => {
  const reads: string[] = []
  return {
    reads,
    readContract: async ({
      address,
      functionName,
    }: {
      address: string
      abi: unknown
      functionName: string
    }) => {
      assert.equal(address, MODULE)
      reads.push(functionName)
      assert.ok(functionName in chainState, `unexpected read ${functionName}`)
      return chainState[functionName]
    },
  }
}

const mockDb = (existing?: Partial<MerkleGovModuleRow>) => {
  const inserted: MerkleGovModuleRow[] = []
  let conflictHandled = false
  return {
    inserted,
    wasConflictHandled: () => conflictHandled,
    find: async (_table: unknown, key: { address: string }) => {
      assert.equal(key.address, MODULE)
      return existing
    },
    insert: (_table: unknown) => ({
      values: (row: MerkleGovModuleRow) => {
        inserted.push(row)
        return {
          onConflictDoNothing: async () => {
            conflictHandled = true
            return row
          },
        }
      },
    }),
  }
}

test('an event arriving with no module row materializes the complete row from chain state', async () => {
  const db = mockDb(undefined)
  const client = mockClient()

  await ensureMerkleGovModuleRow(db, client, {}, MODULE)

  assert.equal(db.inserted.length, 1)
  const row = db.inserted[0]!
  // Every one of the 12 notNull columns must be present and correctly mapped.
  assert.deepEqual(row, {
    address: MODULE,
    avatar: chainState.avatar,
    target: chainState.target,
    merkleSnapshot: chainState.merkleSnapshotContract,
    currentMerkleRoot: chainState.currentMerkleRoot,
    ipfsHash: chainState.ipfsHash,
    ipfsHashCid: chainState.ipfsHashCid,
    totalVotingPower: chainState.totalVotingPower,
    proposalCount: chainState.proposalCount,
    votingDelay: chainState.votingDelay,
    votingPeriod: chainState.votingPeriod,
    quorum: chainState.quorum,
  })
  for (const [column, value] of Object.entries(row)) {
    assert.notEqual(value, undefined, `${column} must never be undefined`)
    assert.notEqual(value, null, `${column} must never be null`)
  }
  // The insert races the discovery handler inside one block: it must tolerate the conflict.
  assert.ok(db.wasConflictHandled(), 'insert must use onConflictDoNothing')
})

test('an existing module row short-circuits the ensure without touching the chain', async () => {
  const db = mockDb({ address: MODULE })
  const client = mockClient()

  await ensureMerkleGovModuleRow(db, client, {}, MODULE)

  assert.equal(client.reads.length, 0, 'no readContract on the happy path')
  assert.equal(db.inserted.length, 0, 'no insert when the row already exists')
})

test('the read-back maps merkleSnapshotContract onto the merkleSnapshot column', async () => {
  const client = mockClient()
  const row = await readMerkleGovModuleRow(client, MODULE)
  assert.equal(row.merkleSnapshot, chainState.merkleSnapshotContract)
  assert.equal(row.address, MODULE)
  // All 11 view functions are read exactly once.
  assert.equal(client.reads.length, 11)
  assert.equal(new Set(client.reads).size, 11)
})
