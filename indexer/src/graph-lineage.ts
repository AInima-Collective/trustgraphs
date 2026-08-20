/**
 * Event-sourced graph actor/configuration/epoch and endorsement provenance.
 *
 * This is intentionally an advisory namespace. Nothing here imports or updates a score, Merkle
 * tree, proof, trust-compose policy, or attribution table. Consumers must apply the fail-closed
 * status fold in `graph-lineage-shared.ts` (and high-stakes consumers should confirm the contract
 * view) before constructing a referral matrix.
 */
import { ponder } from 'ponder:registry'
import {
  graphEndorsement,
  graphLineage,
  graphLineageConfiguration,
  graphLineageEpoch,
} from 'ponder:schema'
import { zeroHash } from 'viem'

import { graphLineageRegistryAbi } from '../abis/graphLineage'

ponder.on(
  'graphLineageRegistry:LineageRegistered',
  async ({ event, context }) => {
    const instanceRegistry = await context.client.readContract({
      address: event.log.address,
      abi: graphLineageRegistryAbi,
      functionName: 'instanceRegistry',
    })
    await context.db.insert(graphLineage).values({
      id: event.args.lineageId,
      chainId: `${context.chain.id}`,
      registry: event.log.address,
      instanceRegistry,
      instanceId: event.args.instanceId,
      familyId: event.args.familyId,
      currentConfigurationId: null,
      currentVersion: 0n,
      authority: event.args.authority,
      controller: event.args.controller,
      displayName: event.args.displayName,
      metadataURI: event.args.metadataURI,
      createdBlock: event.block.number,
      createdTimestamp: event.block.timestamp,
      createdTxHash: event.transaction.hash,
      updatedBlock: event.block.number,
      updatedTimestamp: event.block.timestamp,
      updatedTxHash: event.transaction.hash,
    })
  }
)

ponder.on(
  'graphLineageRegistry:LineageMetadataUpdated',
  async ({ event, context }) => {
    // M0 hazard sweep: a lineage registered before the start block has no row and cannot be
    // reconstructed (the registry ABI exposes no lineage getter; instanceId/familyId are notNull
    // and absent from this event) — log and skip instead of wedging. This namespace is advisory
    // and consumers fold fail-closed (see the file header), so a skipped update degrades safely.
    const lineage = await context.db.find(graphLineage, {
      id: event.args.lineageId,
    })
    if (!lineage) {
      console.warn(
        `graph lineage: metadata update for unobserved lineage ${event.args.lineageId} (registered before the start block?) — skipping`
      )
      return
    }
    await context.db.update(graphLineage, { id: event.args.lineageId }).set({
      authority: event.args.authority,
      displayName: event.args.displayName,
      metadataURI: event.args.metadataURI,
      updatedBlock: event.block.number,
      updatedTimestamp: event.block.timestamp,
      updatedTxHash: event.transaction.hash,
    })
  }
)

ponder.on(
  'graphLineageRegistry:ConfigurationActivated',
  async ({ event, context }) => {
    const lineage = await context.db.find(graphLineage, {
      id: event.args.lineageId,
    })
    if (!lineage) {
      // M0 hazard sweep: same out-of-universe rule as `LineageMetadataUpdated` — the lineage row
      // is not reconstructible from this event or the registry ABI, and throwing here would
      // permanently wedge the indexer on a valid chain. Skipping also withholds the configuration
      // row, which is correct: consumers fail closed on lineages they cannot see.
      console.warn(
        `graph lineage: configuration ${event.args.configurationId} activated for unobserved lineage ${event.args.lineageId} (registered before the start block?) — skipping`
      )
      return
    }
    if (lineage.currentConfigurationId) {
      await context.db
        .update(graphLineageConfiguration, {
          id: lineage.currentConfigurationId,
        })
        .set({
          current: false,
          supersededAtBlock: event.block.number,
        })
    }
    await context.db.insert(graphLineageConfiguration).values({
      id: event.args.configurationId,
      lineageId: event.args.lineageId,
      version: event.args.version,
      programId: event.args.programId,
      snapshot: event.args.snapshot,
      verifier: event.args.verifier,
      registryOrAccumulator: event.args.registryOrAccumulator,
      paramsHash: event.args.paramsHash,
      controller: event.args.controller,
      authority: event.args.authority,
      familyId: event.args.familyId,
      methodId: event.args.methodId,
      scopeHash: event.args.scopeHash,
      identityDomain: event.args.identityDomain,
      sourceLineagePolicyHash: event.args.sourceLineagePolicyHash,
      current: true,
      activatedAt: event.block.timestamp,
      activatedBlock: event.block.number,
      activatedTxHash: event.transaction.hash,
      supersededAtBlock: null,
    })
    await context.db.update(graphLineage, { id: event.args.lineageId }).set({
      familyId: event.args.familyId,
      currentConfigurationId: event.args.configurationId,
      currentVersion: event.args.version,
      controller: event.args.controller,
      authority: event.args.authority,
      updatedBlock: event.block.number,
      updatedTimestamp: event.block.timestamp,
      updatedTxHash: event.transaction.hash,
    })
  }
)

ponder.on('graphLineageRegistry:EpochPublished', async ({ event, context }) => {
  await context.db.insert(graphLineageEpoch).values({
    id: event.args.epochId,
    lineageId: event.args.lineageId,
    configurationId: event.args.configurationId,
    configurationVersion: event.args.configurationVersion,
    checkpointId: event.args.checkpointId,
    freezeBlock: event.args.freezeBlock,
    acceptedAtBlock: event.args.acceptedAtBlock,
    root: event.args.root,
    blobSha256: event.args.blobSha256,
    cidDigest: event.args.cidDigest,
    cid: event.args.cid,
    totalValue: event.args.totalValue.toString(),
    programVKey: event.args.programVKey,
    publishedBlock: event.block.number,
    publishedTimestamp: event.block.timestamp,
    publishedTxHash: event.transaction.hash,
  })
})

ponder.on(
  'graphLineageRegistry:EndorsementIssued',
  async ({ event, context }) => {
    const supersedes =
      event.args.supersedes === zeroHash ? null : event.args.supersedes
    if (supersedes) {
      // M0 hazard sweep: the superseded endorsement may predate the start block. Its back-pointer
      // is decoration on out-of-universe history — log and skip it, but keep inserting the new
      // endorsement below (which carries the forward `supersedes` link regardless).
      const previous = await context.db.find(graphEndorsement, {
        id: supersedes,
      })
      if (previous) {
        await context.db.update(graphEndorsement, { id: supersedes }).set({
          supersededBy: event.args.endorsementId,
        })
      } else {
        console.warn(
          `graph lineage: endorsement ${event.args.endorsementId} supersedes unobserved ${supersedes} (issued before the start block?) — skipping the back-pointer`
        )
      }
    }
    await context.db.insert(graphEndorsement).values({
      id: event.args.endorsementId,
      registry: event.log.address,
      issuerLineageId: event.args.issuerLineageId,
      subjectLineageId: event.args.subjectLineageId,
      issuerConfigurationId: event.args.issuerConfigurationId,
      subjectConfigurationId: event.args.subjectConfigurationId,
      scopeHash: event.args.scopeHash,
      kind: event.args.kind,
      weight: event.args.weight.toString(),
      validFrom: BigInt(event.args.validFrom),
      validUntil: BigInt(event.args.validUntil),
      evidenceURI: event.args.evidenceURI,
      evidenceDigest: event.args.evidenceDigest,
      evidenceMutable: event.args.evidenceDigest === zeroHash,
      sequence: event.args.sequence,
      supersedes,
      supersededBy: null,
      revokedAt: null,
      revocationRef: null,
      issuedBlock: event.block.number,
      issuedTimestamp: event.block.timestamp,
      issuedTxHash: event.transaction.hash,
      revokedBlock: null,
      revokedTxHash: null,
    })
  }
)

ponder.on(
  'graphLineageRegistry:EndorsementRevoked',
  async ({ event, context }) => {
    // M0 hazard sweep: a revocation of an endorsement issued before the start block is
    // out-of-universe — log and skip rather than wedge. Consumers must fold fail-closed (and
    // high-stakes ones confirm `endorsementStatus` on the contract), so an unseen revocation of an
    // unseen endorsement cannot make anything look more trusted than the chain says.
    const endorsement = await context.db.find(graphEndorsement, {
      id: event.args.endorsementId,
    })
    if (!endorsement) {
      console.warn(
        `graph lineage: revocation of unobserved endorsement ${event.args.endorsementId} (issued before the start block?) — skipping`
      )
      return
    }
    await context.db
      .update(graphEndorsement, { id: event.args.endorsementId })
      .set({
        revokedAt: BigInt(event.args.revokedAt),
        revocationRef: event.args.revocationRef,
        revokedBlock: event.block.number,
        revokedTxHash: event.transaction.hash,
      })
  }
)
