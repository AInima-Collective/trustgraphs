import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from 'ponder:api'
import {
  compositionInstance,
  contributionsInstance,
  instance,
  parentAuthorityModule,
  recoveryAuthority,
  snapshotRoleMember,
  subnetworkLink,
  weightedPriorInstance,
} from 'ponder:schema'
import { type Hex, isHex } from 'viem'

import {
  CONSTITUTIONAL_ROLE,
  classifySubnetworkPower,
} from '../subnetwork-shared'

const app = new Hono()

const instanceId = (value: string | undefined) =>
  value && isHex(value) && value.length === 66
    ? (value.toLowerCase() as Hex)
    : null

type CatalogEntry = {
  id: Hex
  name: string
  admin: Hex
  snapshot: Hex
  program:
    | 'trust-graph'
    | 'trust-graph-weighted'
    | 'trust-compose'
    | 'contributions'
}

const catalogEntry = async (id: Hex): Promise<CatalogEntry | null> => {
  const [standard, weighted, composition, contributions] = await Promise.all([
    db.select().from(instance).where(eq(instance.id, id)).limit(1),
    db
      .select()
      .from(weightedPriorInstance)
      .where(eq(weightedPriorInstance.id, id))
      .limit(1),
    db
      .select()
      .from(compositionInstance)
      .where(eq(compositionInstance.id, id))
      .limit(1),
    db
      .select()
      .from(contributionsInstance)
      .where(eq(contributionsInstance.id, id))
      .limit(1),
  ])
  const row = standard[0] ?? weighted[0] ?? composition[0] ?? contributions[0]
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    admin: row.admin,
    snapshot: row.snapshot,
    program: standard[0]
      ? 'trust-graph'
      : weighted[0]
        ? 'trust-graph-weighted'
        : composition[0]
          ? 'trust-compose'
          : 'contributions',
  }
}

const serializeLink = async (row: typeof subnetworkLink.$inferSelect) => {
  const [child, parent] = await Promise.all([
    catalogEntry(row.childInstanceId),
    catalogEntry(row.parentInstanceId),
  ])
  const [modules, roles, recoveries] = await Promise.all([
    db
      .select()
      .from(parentAuthorityModule)
      .where(
        and(
          eq(parentAuthorityModule.childInstanceId, row.childInstanceId),
          eq(parentAuthorityModule.parentInstanceId, row.parentInstanceId)
        )
      )
      .orderBy(desc(parentAuthorityModule.createdBlock)),
    parent
      ? db
          .select()
          .from(snapshotRoleMember)
          .where(
            and(
              eq(snapshotRoleMember.snapshot, child?.snapshot ?? row.registry),
              eq(snapshotRoleMember.role, CONSTITUTIONAL_ROLE),
              eq(snapshotRoleMember.account, parent.admin),
              eq(snapshotRoleMember.active, true)
            )
          )
      : [],
    db
      .select()
      .from(recoveryAuthority)
      .where(eq(recoveryAuthority.instanceId, row.childInstanceId)),
  ])
  const liveModule = modules.find(
    (module) => module.enabled && !module.renounced
  )
  const recovery = recoveries.find(
    (entry) =>
      parent && entry.proposer.toLowerCase() === parent.admin.toLowerCase()
  )
  const classified = classifySubnetworkPower({
    parentModule: Boolean(liveModule),
    constitutionalRole: roles.length > 0,
    recoveryProposer: Boolean(recovery),
    parentModuleDelay: liveModule?.executionDelay ?? null,
  })

  return {
    child,
    parent,
    registry: row.registry,
    status: row.status,
    actor: row.actor,
    power: {
      ...classified,
      verified: row.status === 'active' && classified.verified,
      parentModule: liveModule
        ? {
            address: liveModule.address,
            safe: liveModule.childSafe,
            executionDelay: liveModule.executionDelay.toString(),
          }
        : null,
      recoveryModule: recovery
        ? {
            address: recovery.module,
            proposer: recovery.proposer,
            delay: recovery.delay.toString(),
          }
        : null,
    },
    updatedBlock: row.updatedBlock.toString(),
    updatedTimestamp: row.updatedTimestamp.toString(),
    updatedTxHash: row.updatedTxHash,
  }
}

app.get('/parents/:parentId/children', async (c) => {
  const parentId = instanceId(c.req.param('parentId'))
  if (!parentId) return c.json({ error: 'invalid parent instance id' }, 400)
  const rows = await db
    .select()
    .from(subnetworkLink)
    .where(
      and(
        eq(subnetworkLink.parentInstanceId, parentId),
        eq(subnetworkLink.status, 'active')
      )
    )
    .orderBy(desc(subnetworkLink.updatedBlock))
  return c.json({
    parentInstanceId: parentId,
    children: await Promise.all(rows.map(serializeLink)),
  })
})

app.get('/:childId', async (c) => {
  const childId = instanceId(c.req.param('childId'))
  if (!childId) return c.json({ error: 'invalid child instance id' }, 400)
  const rows = await db
    .select()
    .from(subnetworkLink)
    .where(eq(subnetworkLink.childInstanceId, childId))
    .limit(1)
  if (!rows[0])
    return c.json({ error: 'subnetwork relationship not found' }, 404)
  return c.json(await serializeLink(rows[0]))
})

export default app
