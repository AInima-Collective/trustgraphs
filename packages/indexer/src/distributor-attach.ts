import { ponder } from 'ponder:registry'
import {
  compositionInstance,
  instance,
  weightedPriorInstance,
} from 'ponder:schema'
import { type Hex } from 'viem'

import { insertDistributorConfig } from './merkle'
import { revalidateNetwork } from './utils'

/**
 * `attachDistributor` on a base factory: an instance created without a fund gains one later, owned
 * by the instance's verified constitutional holder. The event is additive (the frozen
 * `*InstanceCreated` shapes are untouched), so this handler only fills the catalog row's
 * `distributor`/`distributorToken` columns and materializes the fund's config row by read-back —
 * the same `ensureDistributorConfig` discipline every distributor handler uses.
 *
 * A missing catalog row is logged and skipped, never thrown: a valid chain must not wedge the
 * indexer (non-negotiable invariant 1), and the fund's own source still indexes its events.
 */
const attachTo =
  (table: typeof instance | typeof weightedPriorInstance | typeof compositionInstance, label: string) =>
  async ({ event, context }: any) => {
    const instanceId = event.args.instanceId as Hex
    const distributor = event.args.distributor as Hex
    const distributorToken = event.args.distributorToken as Hex

    const row = await context.db.find(table, { id: instanceId })
    if (!row) {
      console.warn(
        `DistributorAttached for unknown ${label} instance ${instanceId}; skipping catalog update`
      )
    } else {
      await context.db
        .update(table, { id: instanceId })
        .set({ distributor, distributorToken })
    }

    // Materialize the fund's config row at the attaching block so its later events always find it.
    await insertDistributorConfig(context, distributor)

    if (table === instance) await revalidateNetwork(instanceId)
  }

ponder.on('trustgraphsFactory:DistributorAttached', attachTo(instance, 'trust-graph'))
ponder.on(
  'weightedTrustgraphsFactory:DistributorAttached',
  attachTo(weightedPriorInstance, 'weighted')
)
ponder.on(
  'trustComposeFactory:DistributorAttached',
  attachTo(compositionInstance, 'compose')
)
