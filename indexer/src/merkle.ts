import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { ponder } from 'ponder:registry'
import {
  merkleFundDistribution,
  merkleFundDistributionClaim,
  merkleFundDistributor,
  merkleSnapshot,
} from 'ponder:schema'
import { type Hex } from 'viem'

import {
  merkleFundDistributorAbi,
  merkleSnapshotAbi,
} from '../../frontend/lib/contract-abis'
import { buildTree, outputLeaf, proofFor } from '../../frontend/lib/pagerank/merkle'
import * as offchainSchema from '../offchain.schema'
import { revalidateNetwork } from './utils'

/**
 * The canonical score blob the ZK guest commits (`pagerank_core::cid::canonical_blob`): a flat map of
 * lowercased address -> decimal value string, `{ "0x…": "123", … }`, containing only value > 0
 * entries. Its sha256 is the on-chain `ipfsHash`; there is no metadata or precomputed proofs — those
 * are recomputed here from the guest-identical `outputLeaf`/`buildTree`/`proofFor`.
 */
type ScoreBlob = Record<string, string>

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set')
}
const offchainDb = drizzle(process.env.DATABASE_URL, {
  schema: offchainSchema,
})

ponder.on('merkleSnapshot:setup', async ({ context }) => {
  for (const merkleSnapshotAddress of context.contracts.merkleSnapshot
    .address || []) {
    try {
      const stateCount = await context.client.readContract({
        address: merkleSnapshotAddress,
        abi: merkleSnapshotAbi,
        functionName: 'getStateCount',
        retryEmptyResponse: false,
      })

      const chainId = `${context.chain.id}`

      for (let i = 0; i < Number(stateCount); i++) {
        const state = await context.client.readContract({
          address: merkleSnapshotAddress,
          abi: merkleSnapshotAbi,
          functionName: 'getStateAtIndex',
          args: [BigInt(i)],
        })

        await context.db.insert(merkleSnapshot).values({
          id: `${chainId}-${merkleSnapshotAddress}-${state.root}-${i}`,
          address: merkleSnapshotAddress,
          chainId,
          blockNumber: state.blockNumber,
          timestamp: state.timestamp,
          root: state.root,
          ipfsHash: state.ipfsHash,
          ipfsHashCid: state.ipfsHashCid,
          totalValue: state.totalValue,
        })
      }
    } catch {
      // Contract may not be deployed yet
    }
  }
})

ponder.on('merkleSnapshot:MerkleRootUpdated', async ({ event, context }) => {
  const { root, ipfsHash, ipfsHashCid, totalValue } = event.args

  await context.db.insert(merkleSnapshot).values({
    id: event.id,
    address: event.log.address,
    chainId: `${context.chain.id}`,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    root,
    ipfsHash,
    ipfsHashCid,
    totalValue,
  })

  // If metadata and at least one entry already exist, skip.
  const existingMetadata = await offchainDb
    .select()
    .from(offchainSchema.merkleMetadata)
    .where(
      and(
        eq(
          offchainSchema.merkleMetadata.merkleSnapshotContract,
          event.log.address
        ),
        eq(offchainSchema.merkleMetadata.root, root),
        eq(offchainSchema.merkleMetadata.ipfsHashCid, ipfsHashCid)
      )
    )
    .limit(1)
  const existingEntries = await offchainDb
    .select()
    .from(offchainSchema.merkleEntry)
    .where(
      and(
        eq(
          offchainSchema.merkleEntry.merkleSnapshotContract,
          event.log.address
        ),
        eq(offchainSchema.merkleEntry.root, root),
        eq(offchainSchema.merkleEntry.ipfsHashCid, ipfsHashCid)
      )
    )
    .limit(1)
  if (existingMetadata.length > 0 && existingEntries.length > 0) {
    return
  }

  // Load IPFS data.
  const ipfsGateway = process.env.IPFS_GATEWAY
  if (!ipfsGateway) {
    throw new Error('IPFS_GATEWAY is not set')
  }
  // Use 127.0.0.1 instead of localhost to avoid subdomain redirects
  const ipfsUrl = (ipfsGateway + ipfsHashCid).replace('localhost', '127.0.0.1')
  const merkleRequest = await fetch(ipfsUrl)
  if (!merkleRequest.ok) {
    throw new Error(
      `Failed to fetch merkle tree from IPFS CID ${ipfsHashCid}: ${merkleRequest.status} ${merkleRequest.statusText}`
    )
  }
  const scores = (await merkleRequest.json()) as ScoreBlob
  await insertMerkleData(scores, event, root, ipfsHash, ipfsHashCid, totalValue)

  await revalidateNetwork()
})

async function insertMerkleData(
  scores: ScoreBlob,
  event: any,
  root: string,
  ipfsHash: string,
  ipfsHashCid: string,
  totalValue: bigint
) {
  // The blob is just { account: value }. Rebuild the OZ output tree exactly as the guest did (same
  // leaf/hash-pair encoding, ported in frontend/lib/pagerank/merkle) to recover each account's proof.
  const entries = Object.entries(scores)
  const leaves = entries.map(([account, value]) =>
    outputLeaf(account as Hex, BigInt(value))
  )
  const tree = buildTree(leaves)
  if (tree.length > 0 && tree[0].toLowerCase() !== root.toLowerCase()) {
    // Pinned blob doesn't reproduce the on-chain root — proofs would be useless. Surface it rather
    // than store bad data, but don't crash the whole indexer on one bad snapshot.
    console.warn(
      `merkle: recomputed root ${tree[0]} != on-chain root ${root} for cid ${ipfsHashCid}; skipping entries`
    )
  }

  await offchainDb
    .insert(offchainSchema.merkleMetadata)
    .values({
      merkleSnapshotContract: event.log.address,
      root,
      ipfsHash,
      ipfsHashCid,
      numAccounts: entries.length,
      totalValue,
      sources: [],
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
    })
    .onConflictDoUpdate({
      target: [
        offchainSchema.merkleMetadata.merkleSnapshotContract,
        offchainSchema.merkleMetadata.root,
      ],
      set: {
        ipfsHash: sql.raw(
          `excluded."${offchainSchema.merkleMetadata.ipfsHash.name}"`
        ),
        ipfsHashCid: sql.raw(
          `excluded."${offchainSchema.merkleMetadata.ipfsHashCid.name}"`
        ),
        numAccounts: sql.raw(
          `excluded."${offchainSchema.merkleMetadata.numAccounts.name}"`
        ),
        totalValue: sql.raw(
          `excluded."${offchainSchema.merkleMetadata.totalValue.name}"`
        ),
        sources: sql.raw(
          `excluded."${offchainSchema.merkleMetadata.sources.name}"`
        ),
        blockNumber: sql.raw(
          `excluded."${offchainSchema.merkleMetadata.blockNumber.name}"`
        ),
        timestamp: sql.raw(
          `excluded."${offchainSchema.merkleMetadata.timestamp.name}"`
        ),
      },
    })

  // Skip entries if there are none, or if the recomputed root doesn't match (proofs would be wrong).
  const rootMatches =
    tree.length === 0 || tree[0].toLowerCase() === root.toLowerCase()
  if (entries.length === 0 || !rootMatches) {
    return
  }

  await offchainDb
    .insert(offchainSchema.merkleEntry)
    .values(
      entries.map(([account, value], i) => ({
        merkleSnapshotContract: event.log.address,
        root,
        ipfsHashCid,
        account,
        value: BigInt(value),
        proof: proofFor(tree, leaves[i]) ?? [],
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
      }))
    )
    .onConflictDoUpdate({
      target: [
        offchainSchema.merkleEntry.merkleSnapshotContract,
        offchainSchema.merkleEntry.root,
        offchainSchema.merkleEntry.account,
      ],
      set: {
        ipfsHashCid: sql.raw(
          `excluded."${offchainSchema.merkleEntry.ipfsHashCid.name}"`
        ),
        value: sql.raw(`excluded."${offchainSchema.merkleEntry.value.name}"`),
        proof: sql.raw(`excluded."${offchainSchema.merkleEntry.proof.name}"`),
        blockNumber: sql.raw(
          `excluded."${offchainSchema.merkleEntry.blockNumber.name}"`
        ),
        timestamp: sql.raw(
          `excluded."${offchainSchema.merkleEntry.timestamp.name}"`
        ),
      },
    })
}

ponder.on('merkleFundDistributor:setup', async ({ context }) => {
  for (const merkleFundDistributorAddress of context.contracts
    .merkleFundDistributor.address || []) {
    try {
      const [
        merkleSnapshotAddress,
        owner,
        pendingOwner,
        feeRecipient,
        feePercentage,
        feeRange,
        allowlistEnabled,
        paused,
        allowlist,
      ] = await Promise.all([
        context.client.readContract({
          address: merkleFundDistributorAddress,
          abi: merkleFundDistributorAbi,
          functionName: 'merkleSnapshot',
          retryEmptyResponse: false,
        }),
        context.client.readContract({
          address: merkleFundDistributorAddress,
          abi: merkleFundDistributorAbi,
          functionName: 'owner',
        }),
        context.client.readContract({
          address: merkleFundDistributorAddress,
          abi: merkleFundDistributorAbi,
          functionName: 'pendingOwner',
        }),
        context.client.readContract({
          address: merkleFundDistributorAddress,
          abi: merkleFundDistributorAbi,
          functionName: 'feeRecipient',
        }),
        context.client.readContract({
          address: merkleFundDistributorAddress,
          abi: merkleFundDistributorAbi,
          functionName: 'feePercentage',
        }),
        context.client.readContract({
          address: merkleFundDistributorAddress,
          abi: merkleFundDistributorAbi,
          functionName: 'FEE_RANGE',
        }),
        context.client.readContract({
          address: merkleFundDistributorAddress,
          abi: merkleFundDistributorAbi,
          functionName: 'allowlistEnabled',
        }),
        context.client.readContract({
          address: merkleFundDistributorAddress,
          abi: merkleFundDistributorAbi,
          functionName: 'paused',
        }),
        context.client.readContract({
          address: merkleFundDistributorAddress,
          abi: merkleFundDistributorAbi,
          functionName: 'getAllowlist',
        }),
      ])

      await context.db.insert(merkleFundDistributor).values({
        address: merkleFundDistributorAddress,
        chainId: `${context.chain.id}`,
        paused,
        merkleSnapshot: merkleSnapshotAddress,
        owner,
        pendingOwner,
        feeRecipient,
        feePercentage: (Number(feePercentage) / Number(feeRange)).toString(),
        allowlistEnabled,
        allowlist: [...allowlist],
      })
    } catch {
      // Contract may not be deployed yet
    }
  }
})

ponder.on(
  'merkleFundDistributor:OwnershipTransferStarted',
  async ({ event, context }) => {
    const { pendingOwner } = event.args
    await context.db
      .update(merkleFundDistributor, { address: event.log.address })
      .set({
        pendingOwner,
      })
  }
)

ponder.on(
  'merkleFundDistributor:OwnershipTransferred',
  async ({ event, context }) => {
    const { newOwner } = event.args
    await context.db
      .update(merkleFundDistributor, { address: event.log.address })
      .set({
        owner: newOwner,
        pendingOwner: '0x0000000000000000000000000000000000000000',
      })
  }
)

ponder.on(
  'merkleFundDistributor:FeeRecipientSet',
  async ({ event, context }) => {
    const { newFeeRecipient } = event.args
    await context.db
      .update(merkleFundDistributor, { address: event.log.address })
      .set({
        feeRecipient: newFeeRecipient,
      })
  }
)

ponder.on(
  'merkleFundDistributor:FeePercentageSet',
  async ({ event, context }) => {
    const { newFeePercentage } = event.args
    // Read FEE_RANGE to calculate the percentage
    const feeRange = await context.client.readContract({
      address: event.log.address,
      abi: merkleFundDistributorAbi,
      functionName: 'FEE_RANGE',
    })
    await context.db
      .update(merkleFundDistributor, { address: event.log.address })
      .set({
        feePercentage: (Number(newFeePercentage) / Number(feeRange)).toString(),
      })
  }
)

ponder.on(
  'merkleFundDistributor:MerkleSnapshotUpdated',
  async ({ event, context }) => {
    const { newContract } = event.args
    await context.db
      .update(merkleFundDistributor, { address: event.log.address })
      .set({
        merkleSnapshot: newContract,
      })
  }
)

ponder.on(
  'merkleFundDistributor:DistributorAllowanceUpdated',
  async ({ event, context }) => {
    const { distributor, canDistribute } = event.args
    // Read the current allowlist and update it
    const current = await context.db.find(merkleFundDistributor, {
      address: event.log.address,
    })
    if (!current) return

    let newAllowlist: `0x${string}`[]
    if (canDistribute) {
      // Add to allowlist if not already present
      if (!current.allowlist.includes(distributor)) {
        newAllowlist = [...current.allowlist, distributor]
      } else {
        newAllowlist = current.allowlist
      }
    } else {
      // Remove from allowlist
      newAllowlist = current.allowlist.filter((addr) => addr !== distributor)
    }

    await context.db
      .update(merkleFundDistributor, { address: event.log.address })
      .set({
        allowlist: newAllowlist,
      })
  }
)

ponder.on(
  'merkleFundDistributor:DistributorAllowlistUpdated',
  async ({ event, context }) => {
    const { enabled } = event.args
    await context.db
      .update(merkleFundDistributor, { address: event.log.address })
      .set({
        allowlistEnabled: enabled,
      })
  }
)

ponder.on('merkleFundDistributor:Paused', async ({ event, context }) => {
  await context.db
    .update(merkleFundDistributor, { address: event.log.address })
    .set({
      paused: true,
    })
})

ponder.on('merkleFundDistributor:Unpaused', async ({ event, context }) => {
  await context.db
    .update(merkleFundDistributor, { address: event.log.address })
    .set({
      paused: false,
    })
})

ponder.on('merkleFundDistributor:Distributed', async ({ event, context }) => {
  const { distributionIndex, distributor, token, amountFunded, feeAmount } =
    event.args

  // Read the full distribution state from the contract
  const distribution = await context.client.readContract({
    address: event.log.address,
    abi: merkleFundDistributorAbi,
    functionName: 'getDistribution',
    args: [distributionIndex],
  })

  await context.db.insert(merkleFundDistribution).values({
    id: distributionIndex,
    merkleFundDistributor: event.log.address,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    root: distribution.root,
    ipfsHash: distribution.ipfsHash,
    ipfsHashCid: distribution.ipfsHashCid,
    totalMerkleValue: distribution.totalMerkleValue,
    distributor,
    token,
    amountFunded,
    amountDistributed: 0n,
    feeRecipient: distribution.feeRecipient,
    feeAmount,
  })
})

ponder.on('merkleFundDistributor:Claimed', async ({ event, context }) => {
  const {
    distributionIndex,
    account,
    token,
    amount,
    value,
    newAmountDistributed,
  } = event.args

  // Update the distribution's amountDistributed
  await context.db
    .update(merkleFundDistribution, { id: distributionIndex })
    .set({
      amountDistributed: newAmountDistributed,
    })

  // Insert the claim record
  await context.db.insert(merkleFundDistributionClaim).values({
    id: `${event.log.address}-${distributionIndex}-${account}`,
    merkleFundDistributor: event.log.address,
    distributionIndex,
    account,
    token,
    amount,
    merkleValue: value,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  })
})
