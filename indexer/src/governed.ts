import { ponder } from 'ponder:registry'
import { gnosisSafe, merkleGovModule } from 'ponder:schema'

import { revalidateNetwork } from './utils'
import {
  gnosisSafeAbi,
  merkleGovModuleAbi,
} from '../../frontend/lib/contract-abis'

/**
 * A governed factory transaction creates its Safe and module before emitting the discovery event.
 * Reading the finished contracts here avoids depending on constructor/setup event ordering and
 * makes a browser-created network immediately usable without editing deployment_summary.json.
 */
ponder.on(
  'governedTrustgraphsFactory:GovernedInstanceCreated',
  async ({ event, context }) => {
    const { safe, merkleGovModule: moduleAddress } = event.args

    const [owners, threshold] = await Promise.all([
      context.client.readContract({
        address: safe,
        abi: gnosisSafeAbi,
        functionName: 'getOwners',
      }),
      context.client.readContract({
        address: safe,
        abi: gnosisSafeAbi,
        functionName: 'getThreshold',
      }),
    ])

    await context.db
      .insert(gnosisSafe)
      .values({
        address: safe,
        chainId: `${context.chain.id}`,
        owners: [...owners],
        threshold,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
      })
      .onConflictDoUpdate({
        owners: [...owners],
        threshold,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
      })

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
      context.client.readContract({
        address: moduleAddress,
        abi: merkleGovModuleAbi,
        functionName: 'avatar',
      }),
      context.client.readContract({
        address: moduleAddress,
        abi: merkleGovModuleAbi,
        functionName: 'target',
      }),
      context.client.readContract({
        address: moduleAddress,
        abi: merkleGovModuleAbi,
        functionName: 'merkleSnapshotContract',
      }),
      context.client.readContract({
        address: moduleAddress,
        abi: merkleGovModuleAbi,
        functionName: 'currentMerkleRoot',
      }),
      context.client.readContract({
        address: moduleAddress,
        abi: merkleGovModuleAbi,
        functionName: 'ipfsHash',
      }),
      context.client.readContract({
        address: moduleAddress,
        abi: merkleGovModuleAbi,
        functionName: 'ipfsHashCid',
      }),
      context.client.readContract({
        address: moduleAddress,
        abi: merkleGovModuleAbi,
        functionName: 'totalVotingPower',
      }),
      context.client.readContract({
        address: moduleAddress,
        abi: merkleGovModuleAbi,
        functionName: 'proposalCount',
      }),
      context.client.readContract({
        address: moduleAddress,
        abi: merkleGovModuleAbi,
        functionName: 'votingDelay',
      }),
      context.client.readContract({
        address: moduleAddress,
        abi: merkleGovModuleAbi,
        functionName: 'votingPeriod',
      }),
      context.client.readContract({
        address: moduleAddress,
        abi: merkleGovModuleAbi,
        functionName: 'quorum',
      }),
    ])

    await context.db
      .insert(merkleGovModule)
      .values({
        address: moduleAddress,
        avatar,
        target,
        merkleSnapshot: merkleSnapshotContract,
        currentMerkleRoot,
        ipfsHash,
        ipfsHashCid,
        totalVotingPower,
        proposalCount,
        votingDelay,
        votingPeriod,
        quorum,
      })
      .onConflictDoUpdate({
        avatar,
        target,
        merkleSnapshot: merkleSnapshotContract,
        currentMerkleRoot,
        ipfsHash,
        ipfsHashCid,
        totalVotingPower,
        proposalCount,
        votingDelay,
        votingPeriod,
        quorum,
      })

    await revalidateNetwork()
  }
)
