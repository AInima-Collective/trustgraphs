/** Event-sourced organizational links and their independently verified power instruments. */
import { ponder } from 'ponder:registry'
import {
  parentAuthorityAction,
  parentAuthorityModule,
  snapshotRoleMember,
  subnetworkLink,
} from 'ponder:schema'

import { revalidateNetwork } from './utils'
import { CONSTITUTIONAL_ROLE } from './subnetwork-shared'

const eventState = (event: any) => ({
  updatedBlock: event.block.number,
  updatedTimestamp: event.block.timestamp,
  updatedTxHash: event.transaction.hash,
})

const upsertLink =
  (status: 'pending' | 'active' | 'cancelled' | 'released') =>
  async ({ event, context }: any) => {
    const actor =
      event.args.childAuthority ??
      event.args.parentAuthority ??
      event.args.cancelledBy ??
      event.args.registrar
    await context.db
      .insert(subnetworkLink)
      .values({
        childInstanceId: event.args.childInstanceId,
        parentInstanceId: event.args.parentInstanceId,
        registry: event.log.address,
        status,
        actor,
        ...eventState(event),
      })
      .onConflictDoUpdate({
        parentInstanceId: event.args.parentInstanceId,
        registry: event.log.address,
        status,
        actor,
        ...eventState(event),
      })
    await revalidateNetwork(event.args.childInstanceId)
    await revalidateNetwork(event.args.parentInstanceId)
  }

ponder.on('subnetworkRegistry:ParentClaimed', upsertLink('pending'))
ponder.on('subnetworkRegistry:ChildAccepted', upsertLink('active'))
ponder.on('subnetworkRegistry:SubnetworkRegistered', upsertLink('active'))
ponder.on('subnetworkRegistry:ParentClaimCancelled', upsertLink('cancelled'))
ponder.on('subnetworkRegistry:SubnetworkReleased', upsertLink('released'))

ponder.on(
  'parentAuthorityModuleDeployer:ParentAuthorityModuleConfigured',
  async ({ event, context }: any) => {
    await context.db
      .insert(parentAuthorityModule)
      .values({
        address: event.args.parentAuthorityModule,
        childInstanceId: event.args.childInstanceId,
        parentInstanceId: event.args.parentInstanceId,
        childSafe: event.args.childSafe,
        instanceRegistry: event.args.instanceRegistry,
        executionDelay: BigInt(event.args.executionDelay),
        enabled: false,
        renounced: false,
        createdBlock: event.block.number,
        createdTimestamp: event.block.timestamp,
        createdTxHash: event.transaction.hash,
        ...eventState(event),
      })
      .onConflictDoNothing()
    await revalidateNetwork(event.args.childInstanceId)
  }
)

ponder.on(
  'parentAuthorityModule:ParentPowerRenounced',
  async ({ event, context }: any) => {
    const module = await context.db.find(parentAuthorityModule, {
      address: event.log.address,
    })
    if (!module) return
    await context.db
      .update(parentAuthorityModule, { address: event.log.address })
      .set({ renounced: true, ...eventState(event) })
    await revalidateNetwork(module.childInstanceId)
  }
)

ponder.on(
  'parentAuthorityModule:ParentActionScheduled',
  async ({ event, context }: any) => {
    await context.db.insert(parentAuthorityAction).values({
      actionId: event.args.actionId,
      module: event.log.address,
      childInstanceId: event.args.childInstanceId,
      parentInstanceId: event.args.parentInstanceId,
      nonce: event.args.nonce,
      actor: event.args.parentAuthority,
      target: event.args.target,
      value: event.args.value,
      data: event.args.data,
      safeOperation: event.args.operation,
      status: 'scheduled',
      executableAt: event.args.executableAt,
      ...eventState(event),
    })
  }
)

ponder.on(
  'parentAuthorityModule:ParentActionCancelled',
  async ({ event, context }: any) => {
    const action = await context.db.find(parentAuthorityAction, {
      actionId: event.args.actionId,
    })
    if (!action) return
    await context.db
      .update(parentAuthorityAction, { actionId: event.args.actionId })
      .set({
        actor: event.args.cancelledBy,
        status: 'cancelled',
        ...eventState(event),
      })
  }
)

ponder.on(
  'parentAuthorityModule:ParentActionExecuted',
  async ({ event, context }: any) => {
    await context.db
      .insert(parentAuthorityAction)
      .values({
        actionId: event.args.actionId,
        module: event.log.address,
        childInstanceId: event.args.childInstanceId,
        parentInstanceId: event.args.parentInstanceId,
        nonce: event.args.nonce,
        actor: event.args.executor,
        target: event.args.target,
        value: event.args.value,
        data: event.args.data,
        safeOperation: event.args.operation,
        status: 'executed',
        executableAt: null,
        ...eventState(event),
      })
      .onConflictDoUpdate({
        actor: event.args.executor,
        status: 'executed',
        ...eventState(event),
      })
  }
)

const roleToggled =
  (active: boolean) =>
  async ({ event, context }: any) => {
    if (event.args.role !== CONSTITUTIONAL_ROLE) return
    const snapshot = event.log.address
    const account = event.args.account
    const id = `${snapshot.toLowerCase()}:${CONSTITUTIONAL_ROLE}:${account.toLowerCase()}`
    await context.db
      .insert(snapshotRoleMember)
      .values({
        id,
        snapshot,
        role: CONSTITUTIONAL_ROLE,
        account,
        active,
        ...eventState(event),
      })
      .onConflictDoUpdate({ active, ...eventState(event) })
  }

for (const source of [
  'merkleSnapshot',
  'weightedMerkleSnapshot',
  'compositionMerkleSnapshot',
  'contributionsMerkleSnapshot',
] as const) {
  ponder.on(`${source}:RoleGranted`, roleToggled(true))
  ponder.on(`${source}:RoleRevoked`, roleToggled(false))
}
