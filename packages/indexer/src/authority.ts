/** Keep every catalog's `admin` field aligned with the registry's live authority seam. */
import { eq } from 'drizzle-orm'
import { ponder } from 'ponder:registry'
import {
  compositionInstance,
  contributionsInstance,
  instance,
  weightedPriorInstance,
} from 'ponder:schema'
import type { Hex } from 'viem'

import { revalidateNetwork } from './utils'
import { paramsAuthorityOwnerAbi } from '../abis/subnetwork'

const catalogRowsByController = async (context: any, controller: Hex) => {
  const [standard, weighted, composition, contributions] = await Promise.all([
    context.db.sql
      .select()
      .from(instance)
      .where(eq(instance.paramsController, controller)),
    context.db.sql
      .select()
      .from(weightedPriorInstance)
      .where(eq(weightedPriorInstance.controller, controller)),
    context.db.sql
      .select()
      .from(compositionInstance)
      .where(eq(compositionInstance.controller, controller)),
    context.db.sql
      .select()
      .from(contributionsInstance)
      .where(eq(contributionsInstance.paramsController, controller)),
  ])
  return { standard, weighted, composition, contributions }
}

const updateByController = async (
  context: any,
  controller: Hex,
  admin: Hex
) => {
  const rows = await catalogRowsByController(context, controller)
  await Promise.all([
    ...rows.standard.map((row: any) =>
      context.db.update(instance, { id: row.id }).set({ admin })
    ),
    ...rows.weighted.map((row: any) =>
      context.db.update(weightedPriorInstance, { id: row.id }).set({ admin })
    ),
    ...rows.composition.map((row: any) =>
      context.db.update(compositionInstance, { id: row.id }).set({ admin })
    ),
    ...rows.contributions.map((row: any) =>
      context.db.update(contributionsInstance, { id: row.id }).set({ admin })
    ),
  ])
  await Promise.all(
    [
      ...rows.standard,
      ...rows.weighted,
      ...rows.composition,
      ...rows.contributions,
    ].map((row: any) => revalidateNetwork(row.id))
  )
}

ponder.on(
  'paramsAuthorityController:OwnershipTransferred',
  async ({ event, context }: any) => {
    await updateByController(context, event.log.address, event.args.newOwner)
  }
)

ponder.on(
  'instanceRegistry:ParamsAuthorityUpdated',
  async ({ event, context }: any) => {
    const { instanceId, newAuthority: controller } = event.args
    let admin = controller
    try {
      admin = await context.client.readContract({
        address: controller,
        abi: paramsAuthorityOwnerAbi,
        functionName: 'owner',
      })
    } catch {
      // Bare authorities intentionally use the controller address itself.
    }

    const [standard, weighted, composition, contributions] = await Promise.all([
      context.db.find(instance, { id: instanceId }),
      context.db.find(weightedPriorInstance, { id: instanceId }),
      context.db.find(compositionInstance, { id: instanceId }),
      context.db.find(contributionsInstance, { id: instanceId }),
    ])

    if (standard)
      await context.db
        .update(instance, { id: instanceId })
        .set({ paramsController: controller, admin })
    if (weighted)
      await context.db
        .update(weightedPriorInstance, { id: instanceId })
        .set({ controller, admin })
    if (composition)
      await context.db
        .update(compositionInstance, { id: instanceId })
        .set({ controller, admin })
    if (contributions)
      await context.db
        .update(contributionsInstance, { id: instanceId })
        .set({ paramsController: controller, admin })

    if (standard || weighted || composition || contributions)
      await revalidateNetwork(instanceId)
  }
)
