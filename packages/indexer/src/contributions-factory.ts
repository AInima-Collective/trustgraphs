/**
 * Contributions-round discovery — the round catalog, built from the chain.
 *
 * `ContributionsFactory.ContributionsInstanceCreated` is the discovery event: one handler turns
 * it into one `contributions_instance` row, and the same event is what Ponder's `factory()`
 * sources use to discover the round's resolver / snapshot / distributor children
 * (packages/indexer/ponder.config.ts). This replaces the build-time `CONTRIBUTIONS_INSTANCES` import from
 * `deployment_summary.json`: a round created a minute ago is indexed with no config edit, no
 * restart, and no redeploy — the `src/factory.ts` pattern, applied to the contributions program.
 */
import { ponder } from 'ponder:registry'
import { contributionsInstance, merkleFundDistributor } from 'ponder:schema'
import { zeroAddress } from 'viem'

import { paramsSnapshot } from './contributions-shared'
import { fetchMetadata } from './factory'
import { revalidateNetwork } from './utils'
import { paramsHash } from '../../frontend/lib/contributions'

ponder.on(
  'contributionsFactory:ContributionsInstanceCreated',
  async ({ event, context }: any) => {
    const {
      instanceId,
      parentInstanceId,
      creator,
      admin,
      name,
      metadataURI,
      trustAccumulator,
      mirror,
      resolver,
      snapshot,
      distributor,
      distributorToken,
      epochLength,
      claimSchemaUid,
      responseSchemaUid,
      valuationSchemaUid,
      params,
    } = event.args

    const normalized = { ...params, trustedSeeds: [...params.trustedSeeds] }
    const hash = paramsHash(normalized)
    const metadata = await fetchMetadata(metadataURI)

    console.log(
      `contributions-factory: ContributionsInstanceCreated ${instanceId} "${name}" @ block ${event.block.number} parent ${parentInstanceId} snapshot ${snapshot}`
    )

    await context.db.insert(contributionsInstance).values({
      id: instanceId,
      factory: event.log.address,
      chainId: `${context.chain.id}`,
      parentInstanceId,
      creator,
      admin,
      name,
      metadataURI,
      metadata,
      trustAccumulator,
      mirror,
      resolver,
      snapshot,
      distributor,
      distributorToken:
        distributorToken === zeroAddress ? null : distributorToken,
      epochLength,
      claimSchemaUid,
      responseSchemaUid,
      valuationSchemaUid,
      paramsHash: hash,
      params: paramsSnapshot(normalized),
      roundStart: normalized.roundStart,
      roundEnd: normalized.roundEnd,
      totalPool: normalized.totalPool,
      createdBlock: event.block.number,
      createdTimestamp: event.block.timestamp,
      createdTxHash: event.transaction.hash,
    })

    // Seed the distributor's config row from its birth state instead of reading it back in a
    // `setup` handler (the src/factory.ts pattern). The factory constructs it with
    // `owner = feeRecipient = admin`, no fee, no allowlist and unpaused, so this is exact — and it
    // means the first `Distributed`/`Claimed`/… event for a brand-new round can never arrive
    // before the row it updates (the ensure discipline: materialize before any child update).
    await context.db
      .insert(merkleFundDistributor)
      .values({
        address: distributor,
        chainId: `${context.chain.id}`,
        paused: false,
        merkleSnapshot: snapshot,
        owner: admin,
        pendingOwner: zeroAddress,
        feeRecipient: admin,
        feePercentage: '0',
        allowlistEnabled: false,
        allowlist: [],
      })
      .onConflictDoNothing()

    await revalidateNetwork(instanceId)
  }
)

// `SchemaAdopted` is observability only: the adopted UID is already carried by the creation
// event (and pinned in the round's params), so there is no row to update — an explicit no-op
// subscription would only add a handler that ignores its event. Deliberately not subscribed.
