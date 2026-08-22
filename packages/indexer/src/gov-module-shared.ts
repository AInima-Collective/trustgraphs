/**
 * The one read-back that turns a MerkleGovModule address into a complete `merkle_gov_module` row.
 *
 * Shared by the discovery handler (src/governed.ts) and the ensure-before-update path
 * (src/gov.ts). All 12 schema columns are notNull with no defaults, so a row can never be
 * upserted from event args alone — it must be read from the finished contract. Ponder's
 * `context.client` reads at the event's block, i.e. the transaction's post-state: by the time any
 * module event is dispatched the module is fully constructed, so the read-back is complete and
 * independent of log order within the creation block.
 *
 * This file deliberately imports nothing from `ponder:*` so the materialization logic is unit
 * testable (src/gov-module-shared.test.ts).
 */
import { type Address, type Hex, parseAbi } from 'viem'

/**
 * The module's row-relevant view surface. Deliberately a local `parseAbi` (the `packages/indexer/abis/`
 * convention) rather than an import of `packages/frontend/lib/contract-abis`: that module is CommonJS
 * under the test runner, and this file must stay importable from plain node tests. Signatures
 * verified against the generated `merkleGovModuleAbi`.
 */
export const merkleGovModuleViewAbi = parseAbi([
  'function avatar() view returns (address)',
  'function target() view returns (address)',
  'function merkleSnapshotContract() view returns (address)',
  'function currentMerkleRoot() view returns (bytes32)',
  'function ipfsHash() view returns (bytes32)',
  'function ipfsHashCid() view returns (string)',
  'function totalVotingPower() view returns (uint256)',
  'function proposalCount() view returns (uint256)',
  'function votingDelay() view returns (uint256)',
  'function votingPeriod() view returns (uint256)',
  'function quorum() view returns (uint256)',
])

type GovModuleViewFunction =
  (typeof merkleGovModuleViewAbi)[number]['name']

/** The minimal slice of Ponder's `context.client` the read-back needs. */
export type GovModuleReadClient = {
  readContract(args: {
    address: Address
    abi: typeof merkleGovModuleViewAbi
    functionName: GovModuleViewFunction
  }): Promise<unknown>
}

/** The minimal slice of Ponder's `context.db` the ensure needs. */
export type GovModuleDb = {
  find(table: unknown, key: { address: Address }): Promise<unknown>
  insert(table: unknown): {
    values(row: MerkleGovModuleRow): { onConflictDoNothing(): Promise<unknown> }
  }
}

export type MerkleGovModuleRow = {
  address: Address
  avatar: Address
  target: Address
  merkleSnapshot: Address
  currentMerkleRoot: Hex
  ipfsHash: Hex
  ipfsHashCid: string
  totalVotingPower: bigint
  proposalCount: bigint
  votingDelay: bigint
  votingPeriod: bigint
  quorum: bigint
}

/** Read every column of a module row from the contract at the block being processed. */
export async function readMerkleGovModuleRow(
  client: GovModuleReadClient,
  address: Address
): Promise<MerkleGovModuleRow> {
  const read = (functionName: GovModuleViewFunction) =>
    client.readContract({ address, abi: merkleGovModuleViewAbi, functionName })

  const [
    avatar,
    target,
    merkleSnapshotContract,
    currentMerkleRoot,
    ipfsHash,
    ipfsHashCid,
    totalVotingPower,
    proposalCount,
    votingDelay,
    votingPeriod,
    quorum,
  ] = await Promise.all([
    read('avatar'),
    read('target'),
    read('merkleSnapshotContract'),
    read('currentMerkleRoot'),
    read('ipfsHash'),
    read('ipfsHashCid'),
    read('totalVotingPower'),
    read('proposalCount'),
    read('votingDelay'),
    read('votingPeriod'),
    read('quorum'),
  ])

  return {
    address,
    avatar: avatar as Address,
    target: target as Address,
    merkleSnapshot: merkleSnapshotContract as Address,
    currentMerkleRoot: currentMerkleRoot as Hex,
    ipfsHash: ipfsHash as Hex,
    ipfsHashCid: ipfsHashCid as string,
    totalVotingPower: totalVotingPower as bigint,
    proposalCount: proposalCount as bigint,
    votingDelay: votingDelay as bigint,
    votingPeriod: votingPeriod as bigint,
    quorum: quorum as bigint,
  }
}

/**
 * Materialize a module's birth row if it does not exist yet.
 *
 * A governed factory deploys the module before it emits `GovernedInstanceCreated`. Ponder
 * discovers the module from that later event, then replays the constructor's earlier logs
 * (`MerkleSnapshotContractUpdated`, …), which therefore arrive before any handler has inserted
 * the row. Calling this at the head of every module update makes an update-before-row impossible
 * instead of merely unlikely — the old failure mode was a non-retryable `RecordNotFoundError`
 * that rolled back the whole creation block and crash-looped the indexer permanently.
 */
export async function ensureMerkleGovModuleRow(
  db: GovModuleDb,
  client: GovModuleReadClient,
  table: unknown,
  address: Address
): Promise<void> {
  const existing = await db.find(table, { address })
  if (existing) return
  const row = await readMerkleGovModuleRow(client, address)
  await db.insert(table).values(row).onConflictDoNothing()
}
