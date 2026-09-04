import { ponder } from 'ponder:registry'
import { gnosisSafe, merkleGovModule, recoveryAuthority } from 'ponder:schema'

import { readMerkleGovModuleRow } from './gov-module-shared'
import { revalidateNetwork } from './utils'
import {
  gnosisSafeAbi,
  governedTrustgraphsFactoryAbi,
} from '../../frontend/lib/contract-abis'

/**
 * A governed factory transaction creates its Safe and module before emitting the discovery event.
 * Reading the finished contracts here avoids depending on constructor/setup event ordering and
 * makes a browser-created network immediately usable without editing deployment_summary.json.
 *
 * ONE handler, registered for every governed wrapper: the trust-graph, weighted, and compose
 * wrappers emit the same `GovernedInstanceCreated(instanceId, creator, safe, merkleGovModule,
 * snapshot)` signature by construction, and everything below reads the finished contracts rather
 * than wrapper-specific arguments.
 */
const onGovernedInstanceCreated = async ({ event, context }: any) => {
  const { instanceId, safe, merkleGovModule: moduleAddress } = event.args

  const [owners, threshold, authority] = await Promise.all([
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
    context.client.readContract({
      address: event.log.address,
      abi: governedTrustgraphsFactoryAbi,
      functionName: 'authorityOf',
      args: [instanceId],
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
    .values({
      address: moduleAddress,
      ...moduleState,
      recoveryModule: authority.recoveryModule,
      executionGuard: authority.executionGuard,
    })
    .onConflictDoUpdate({
      ...moduleState,
      recoveryModule: authority.recoveryModule,
      executionGuard: authority.executionGuard,
    })

  await revalidateNetwork()
}

ponder.on(
  'governedTrustgraphsFactory:GovernedInstanceCreated',
  onGovernedInstanceCreated
)
ponder.on(
  'governedWeightedTrustgraphsFactory:GovernedInstanceCreated',
  onGovernedInstanceCreated
)
ponder.on(
  'governedTrustComposeFactory:GovernedInstanceCreated',
  onGovernedInstanceCreated
)

const onGovernedAuthorityInstalled = async ({ event, context }: any) => {
  await context.db
    .insert(recoveryAuthority)
    .values({
      module: event.args.recoveryModule,
      instanceId: event.args.instanceId,
      safe: event.args.safe,
      proposer: event.args.recoveryProposer,
      delay: BigInt(event.args.recoveryDelay),
      updatedBlock: event.block.number,
      updatedTimestamp: event.block.timestamp,
      updatedTxHash: event.transaction.hash,
    })
    .onConflictDoUpdate({
      safe: event.args.safe,
      proposer: event.args.recoveryProposer,
      delay: BigInt(event.args.recoveryDelay),
      updatedBlock: event.block.number,
      updatedTimestamp: event.block.timestamp,
      updatedTxHash: event.transaction.hash,
    })
}

ponder.on(
  'governedTrustgraphsFactory:GovernedAuthorityInstalled',
  onGovernedAuthorityInstalled
)
ponder.on(
  'governedWeightedTrustgraphsFactory:GovernedAuthorityInstalled',
  onGovernedAuthorityInstalled
)
ponder.on(
  'governedTrustComposeFactory:GovernedAuthorityInstalled',
  onGovernedAuthorityInstalled
)

ponder.on(
  'delayedRecoveryModule:RecoveryProposerUpdated',
  async ({ event, context }: any) => {
    const recovery = await context.db.find(recoveryAuthority, {
      module: event.log.address,
    })
    if (!recovery) return
    await context.db
      .update(recoveryAuthority, { module: event.log.address })
      .set({
        proposer: event.args.newProposer,
        updatedBlock: event.block.number,
        updatedTimestamp: event.block.timestamp,
        updatedTxHash: event.transaction.hash,
      })
    await revalidateNetwork(recovery.instanceId)
  }
)
