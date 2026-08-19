import { ponder } from 'ponder:registry'
import { gnosisSafe, merkleGovModule } from 'ponder:schema'

import { readMerkleGovModuleRow } from './gov-module-shared'
import { revalidateNetwork } from './utils'
import { gnosisSafeAbi } from '../../frontend/lib/contract-abis'

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

    // Shared read-back (src/gov-module-shared.ts): the same materialization gov.ts's ensure path
    // uses, so a row born here and a row born from an out-of-order constructor log are identical.
    // Upsert rather than insert: the module's constructor `MerkleSnapshotContractUpdated` log can
    // legitimately arrive before this discovery event, in which case gov.ts already materialized
    // the row and this refresh is a no-op with the same values.
    const { address: _moduleRowAddress, ...moduleState } =
      await readMerkleGovModuleRow(context.client, moduleAddress)

    await context.db
      .insert(merkleGovModule)
      .values({ address: moduleAddress, ...moduleState })
      .onConflictDoUpdate(moduleState)

    await revalidateNetwork()
  }
)
