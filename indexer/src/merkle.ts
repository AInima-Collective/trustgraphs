import { and, desc, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { ponder } from 'ponder:registry'
import {
  compositionInstance,
  compositionPolicyVersion,
  instance,
  merkleFundDistribution,
  merkleFundDistributionClaim,
  merkleFundDistributor,
  merkleSnapshot,
  parameterVersion,
  proofSubmission,
  snapshotTrigger,
} from 'ponder:schema'
import { type Hex } from 'viem'

import { type ScoreBlob, deriveAddressMerkleRows } from './merkle-ingest'
import { validateScoreBlob } from './score-program'
import * as offchainSchema from '../offchain.schema'
import { ingestHypercertsScores } from './anchor'
import {
  compositionEpochExists,
  ingestCompositionScores,
} from './composition-ingest'
import { compositionCheckpointForEvent } from './composition-receipt'
import { ingestContributionsScores } from './contributions'
import { ingestNostrWorkspaceScores } from './nostr-workspace'
import type { ScoreProgramProvenance } from './score-program'
import {
  canRepairScoreRowsOnRestart,
  scoreRowDiscriminators,
} from './score-program-backfill'
import { requireAuthenticatedScoreBinding } from './score-program-binding'
import { type SharedArgs, revalidateNetwork, staticAddresses } from './utils'
import {
  merkleFundDistributorAbi,
  merkleSnapshotAbi,
} from '../../frontend/lib/contract-abis'

/**
 * The canonical score blob the ZK guest commits (`pagerank_core::cid::canonical_blob`): a flat map of
 * lowercased address -> decimal value string, `{ "0x…": "123", … }`, containing only value > 0
 * entries. Its sha256 is the on-chain `ipfsHash`; there is no metadata or precomputed proofs — those
 * are recomputed here from the guest-identical `outputLeaf`/`buildTree`/`proofFor`.
 */
const positiveIntegerEnv = (name: string, fallback: number) => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`)
  }
  return value
}

const IPFS_FETCH_ATTEMPTS = positiveIntegerEnv('IPFS_FETCH_ATTEMPTS', 5)
const IPFS_FETCH_TIMEOUT_MS = positiveIntegerEnv(
  'IPFS_FETCH_TIMEOUT_MS',
  10_000
)

/**
 * Gateways commonly return 404/504 briefly after a pin. Retry inside the indexing function so a
 * transient propagation race does not kill the writer and rely on the process supervisor for the
 * exact same retry. A permanently unavailable blob still throws: serving a root with a silently
 * empty member list would be worse than marking the writer unhealthy while the stable production
 * read server continues to serve the last completed schema.
 */
const fetchIpfs = async (url: string): Promise<Response> => {
  let lastFailure = 'unknown error'
  for (let attempt = 1; attempt <= IPFS_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(IPFS_FETCH_TIMEOUT_MS),
      })
      if (response.ok) return response
      lastFailure = `${response.status} ${response.statusText}`
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }

    if (attempt < IPFS_FETCH_ATTEMPTS) {
      const delayMs = Math.min(1_000 * 2 ** (attempt - 1), 8_000)
      console.warn(
        `merkle: IPFS fetch attempt ${attempt}/${IPFS_FETCH_ATTEMPTS} failed (${lastFailure}); retrying in ${delayMs}ms`
      )
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw new Error(
    `IPFS gateway failed after ${IPFS_FETCH_ATTEMPTS} attempts: ${lastFailure}`
  )
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set')
}
const offchainDb = drizzle(process.env.DATABASE_URL, {
  schema: offchainSchema,
})

/**
 * Backfill the state history of statically-addressed snapshots. Factory-created instances need
 * none of it: they are indexed from the block they were created in, so every `MerkleRootUpdated`
 * they have ever emitted arrives as a normal event.
 */
const backfillSnapshotStates = async (
  context: any,
  addresses: readonly Hex[]
) => {
  for (const merkleSnapshotAddress of addresses) {
    try {
      const code = await context.client.getCode({
        address: merkleSnapshotAddress,
      })
      if (!code || code === '0x') continue

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
}

ponder.on('merkleSnapshot:setup', async ({ context }) => {
  await backfillSnapshotStates(
    context,
    staticAddresses(context.contracts.merkleSnapshot.address)
  )
})

ponder.on('programSnapshot:setup', async ({ context }) => {
  await backfillSnapshotStates(
    context,
    staticAddresses(context.contracts.programSnapshot.address)
  )
})

ponder.on('weightedMerkleSnapshot:setup', async ({ context }) => {
  await backfillSnapshotStates(
    context,
    staticAddresses(context.contracts.weightedMerkleSnapshot.address)
  )
})

ponder.on('compositionMerkleSnapshot:setup', async ({ context }) => {
  await backfillSnapshotStates(
    context,
    staticAddresses(context.contracts.compositionMerkleSnapshot.address)
  )
})

ponder.on('contributionsMerkleSnapshot:setup', async ({ context }) => {
  await backfillSnapshotStates(
    context,
    staticAddresses(context.contracts.contributionsMerkleSnapshot.address)
  )
})

const onMerkleRootUpdated = async ({
  event,
  context,
}: SharedArgs<'merkleSnapshot:MerkleRootUpdated'>) => {
  const { root, ipfsHash, ipfsHashCid, totalValue } = event.args
  const { program, provenance } = await requireAuthenticatedScoreBinding(
    context,
    event.log.address
  )
  if (program.ingestion === 'not-enabled') {
    throw new Error(
      `score ingestion refused: ${program.name} is registered but its decoder/table is not enabled`
    )
  }
  console.log(
    `merkle: MerkleRootUpdated from ${event.log.address} @ block ${event.block.number} root ${root} cid ${ipfsHashCid} program ${program.name}`
  )

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

  const metadataTable =
    program.ingestion === 'hypercerts'
      ? offchainSchema.hypercertsMetadata
      : program.ingestion === 'nostr-workspace'
        ? offchainSchema.nostrWorkspaceMetadata
        : offchainSchema.merkleMetadata
  const entryTable =
    program.ingestion === 'hypercerts'
      ? offchainSchema.hypercertsScore
      : program.ingestion === 'nostr-workspace'
        ? offchainSchema.nostrWorkspaceScore
        : offchainSchema.merkleEntry

  // If matching program-specific metadata and at least one score already exist, repair provenance
  // columns left by a pre-discriminator indexer and skip the untrusted blob fetch.
  const existingMetadata = await offchainDb
    .select()
    .from(metadataTable)
    .where(
      and(
        eq(metadataTable.merkleSnapshotContract, event.log.address),
        eq(metadataTable.root, root),
        eq(metadataTable.ipfsHashCid, ipfsHashCid)
      )
    )
    .limit(1)
  const existingEntries = await offchainDb
    .select()
    .from(entryTable)
    .where(
      and(
        eq(entryTable.merkleSnapshotContract, event.log.address),
        eq(entryTable.root, root)
      )
    )
    .limit(1)
  // A contributions snapshot additionally needs its derived round/score rows — a crash (or an
  // older indexer build) can leave the generic rows present but the round missing, so the skip
  // must consider both surfaces or the ingestion is never retried.
  const isContributions = program.ingestion === 'contributions'
  const isComposition = program.ingestion === 'composition'
  const existingRound = isContributions
    ? await offchainDb
        .select()
        .from(offchainSchema.contributionRound)
        .where(
          and(
            eq(
              offchainSchema.contributionRound.merkleSnapshotContract,
              event.log.address.toLowerCase()
            ),
            eq(offchainSchema.contributionRound.root, root)
          )
        )
        .limit(1)
    : []
  const compositionCheckpoint = isComposition
    ? await compositionCheckpointForEvent(event, context)
    : null
  const existingCompositionEpoch =
    compositionCheckpoint === null
      ? false
      : await compositionEpochExists(
          offchainDb,
          event.log.address,
          compositionCheckpoint
        )
  if (
    canRepairScoreRowsOnRestart(program, {
      metadata: existingMetadata.length > 0,
      entries: existingEntries.length > 0,
      contributionRound: existingRound.length > 0,
      compositionEpoch: existingCompositionEpoch,
    })
  ) {
    const discriminators = scoreRowDiscriminators(program)
    const rootWhere = and(
      eq(metadataTable.merkleSnapshotContract, event.log.address),
      eq(metadataTable.root, root)
    )
    await offchainDb
      .update(metadataTable)
      .set({
        ...discriminators.primary,
        programProvenance: provenance,
      })
      .where(rootWhere)
    await offchainDb
      .update(entryTable)
      .set(discriminators.primary)
      .where(
        and(
          eq(entryTable.merkleSnapshotContract, event.log.address),
          eq(entryTable.root, root)
        )
      )
    if (isContributions) {
      const contributionsWhere = and(
        eq(
          offchainSchema.contributionRound.merkleSnapshotContract,
          event.log.address.toLowerCase()
        ),
        eq(offchainSchema.contributionRound.root, root)
      )
      await Promise.all([
        offchainDb
          .update(offchainSchema.contributionRound)
          .set({
            ...discriminators.primary,
            programProvenance: provenance,
          })
          .where(contributionsWhere),
        offchainDb
          .update(offchainSchema.contributionScore)
          .set(discriminators.claim!)
          .where(
            and(
              eq(
                offchainSchema.contributionScore.merkleSnapshotContract,
                event.log.address.toLowerCase()
              ),
              eq(offchainSchema.contributionScore.root, root)
            )
          ),
        offchainDb
          .update(offchainSchema.contributionValuationAudit)
          .set(discriminators.claim!)
          .where(
            and(
              eq(
                offchainSchema.contributionValuationAudit
                  .merkleSnapshotContract,
                event.log.address.toLowerCase()
              ),
              eq(offchainSchema.contributionValuationAudit.root, root)
            )
          ),
      ])
    }
    return
  }

  // Load IPFS data.
  const ipfsGateway = process.env.IPFS_GATEWAY
  if (!ipfsGateway) {
    throw new Error('IPFS_GATEWAY is not set')
  }
  // Use 127.0.0.1 instead of localhost to avoid subdomain redirects
  const ipfsUrl = (ipfsGateway + ipfsHashCid).replace('localhost', '127.0.0.1')
  let merkleRequest: Response
  try {
    merkleRequest = await fetchIpfs(ipfsUrl)
  } catch (error) {
    // Throwing stalls Ponder on this event, which is deliberate: the alternative is a network
    // whose member list is silently and permanently empty. But it means one unfetchable blob stops
    // indexing for everything, so the message has to be enough to fix it without reading this file.
    throw new Error(
      `Failed to fetch merkle tree from IPFS CID ${ipfsHashCid}: ` +
        `${error instanceof Error ? error.message : String(error)} (${ipfsUrl}).\n` +
        `The root is on chain but its scores are not fetchable, so no member list can be built ` +
        `and /network/${event.log.address} will 404. Indexing is paused here and will resume by ` +
        `itself once the blob is retrievable.\n` +
        `Check, in order: (1) is an IPFS node actually serving IPFS_GATEWAY; (2) did whoever ` +
        `produced this root satisfy its [ipfs] publication target minimum; (3) does each target's ` +
        `gateway serve the exact bytes accepted by its add API? Repair the target or run operator ` +
        `republish --instance <id> --checkpoint <id>. The CID identifies the bytes but does not ` +
        `guarantee that any provider still stores them.`
    )
  }
  const outputBytes = new Uint8Array(await merkleRequest.arrayBuffer())
  let rawScores: Record<string, unknown>
  try {
    rawScores = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(outputBytes)
    )
  } catch {
    throw new Error(`score blob ${ipfsHashCid} is not valid UTF-8 JSON`)
  }
  const scores = validateScoreBlob(rawScores, program) as ScoreBlob
  console.log(
    `merkle: blob fetched (${Object.keys(scores).length} entries) — authenticated ${program.name}/${program.outputDomainName} routing to ${program.ingestion}`
  )
  if (program.ingestion === 'hypercerts') {
    await ingestHypercertsScores(
      scores,
      event,
      context,
      root,
      ipfsHash,
      ipfsHashCid,
      totalValue,
      provenance
    )
  } else if (program.ingestion === 'nostr-workspace') {
    await ingestNostrWorkspaceScores(
      scores,
      event,
      context,
      root,
      ipfsHash,
      ipfsHashCid,
      totalValue,
      outputBytes,
      provenance
    )
  } else {
    // Composition is all-or-nothing: authenticate every captured source and reproduce its policy,
    // attribution, output bytes, proof provenance, and accepted state before generic Merkle rows
    // become visible to consumers.
    if (isComposition) {
      await ingestCompositionScores(
        event,
        context,
        outputBytes,
        provenance,
        async (cid) => {
          const sourceUrl = (ipfsGateway + cid).replace(
            'localhost',
            '127.0.0.1'
          )
          const response = await fetchIpfs(sourceUrl)
          return new Uint8Array(await response.arrayBuffer())
        },
        offchainDb
      )
    }

    await insertMerkleData(
      scores,
      event,
      root,
      ipfsHash,
      ipfsHashCid,
      totalValue,
      provenance
    )

    // A contributions instance's blob is address-keyed like the trust graph's (v1 leaves are
    // address-domain), so the generic ingestion above already produced the payout entries +
    // proofs. Additionally re-derive the per-claim scores / audit rows, root-validated
    // (src/contributions.ts) — no-op for non-contributions snapshots.
    if (isContributions) {
      await ingestContributionsScores(
        scores,
        event,
        context,
        root,
        ipfsHash,
        ipfsHashCid,
        totalValue,
        provenance
      )
    }
  }

  await revalidateNetwork()
}

/**
 * `MerkleProofSubmitted` — who produced a root, and who is owed for it.
 *
 * Recorded separately from `MerkleRootUpdated` because the two answer different questions and
 * carry different fields. In particular `prover` (`msg.sender`, who paid the gas) and `recipient`
 * (what the guest committed in the journal, who the bounty is owed to) are distinct, and keeping
 * them apart is the whole visible consequence of the front-running defence: a relayed root shows
 * one address paying and another being paid.
 */
const onMerkleProofSubmitted = async ({
  event,
  context,
}: SharedArgs<'merkleSnapshot:MerkleProofSubmitted'>) => {
  const { checkpointId, root, prover, recipient } = event.args
  await context.db.insert(proofSubmission).values({
    id: event.id,
    snapshot: event.log.address,
    chainId: `${context.chain.id}`,
    checkpointId,
    root,
    prover,
    recipient,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  })
}

ponder.on('merkleSnapshot:MerkleProofSubmitted', onMerkleProofSubmitted)
ponder.on('programSnapshot:MerkleProofSubmitted', onMerkleProofSubmitted)
ponder.on('weightedMerkleSnapshot:MerkleProofSubmitted', onMerkleProofSubmitted)
ponder.on(
  'compositionMerkleSnapshot:MerkleProofSubmitted',
  onMerkleProofSubmitted
)
ponder.on(
  'contributionsMerkleSnapshot:MerkleProofSubmitted',
  onMerkleProofSubmitted
)

/** Attach a parameter version to the first checkpoint that actually pins it. */
const onCheckpointParamsPinned = async ({
  event,
  context,
}: SharedArgs<'merkleSnapshot:CheckpointParamsPinned'>) => {
  const [network] = await context.db.sql
    .select()
    .from(instance)
    .where(eq(instance.snapshot, event.log.address))
    .limit(1)
  if (network?.paramsController) {
    // A rollback may publish the same tuple/hash as an older version. The newest matching
    // unpinned version is therefore the one this checkpoint activates.
    const [version] = await context.db.sql
      .select()
      .from(parameterVersion)
      .where(
        and(
          eq(parameterVersion.instanceId, network.id),
          eq(parameterVersion.paramsHash, event.args.paramsHash),
          eq(parameterVersion.valid, true)
        )
      )
      .orderBy(desc(parameterVersion.version))
      .limit(1)
    if (version && version.firstCheckpoint === null) {
      await context.db.update(parameterVersion, { id: version.id }).set({
        firstCheckpoint: event.args.checkpointId,
        firstCheckpointBlock: event.block.number,
        firstCheckpointTimestamp: event.block.timestamp,
        firstCheckpointTxHash: event.transaction.hash,
      })
      if (network.paramsVersion === version.version) {
        await context.db.update(instance, { id: network.id }).set({
          paramsFirstCheckpoint: event.args.checkpointId,
        })
      }
    }
  }

  // Composition policy history is intentionally updated in this same callback: Ponder permits
  // only one indexing function per source/event key.
  const [composition] = await context.db.sql
    .select()
    .from(compositionInstance)
    .where(eq(compositionInstance.snapshot, event.log.address))
    .limit(1)
  if (!composition) return
  const [policyVersion] = await context.db.sql
    .select()
    .from(compositionPolicyVersion)
    .where(
      and(
        eq(compositionPolicyVersion.instanceId, composition.id),
        eq(compositionPolicyVersion.paramsHash, event.args.paramsHash)
      )
    )
    .orderBy(desc(compositionPolicyVersion.version))
    .limit(1)
  if (!policyVersion || policyVersion.firstCheckpoint !== null) return
  await context.db
    .update(compositionPolicyVersion, { id: policyVersion.id })
    .set({
      firstCheckpoint: event.args.checkpointId,
      firstCheckpointBlock: event.block.number,
      firstCheckpointTimestamp: event.block.timestamp,
      firstCheckpointTxHash: event.transaction.hash,
    })
}

ponder.on('merkleSnapshot:CheckpointParamsPinned', onCheckpointParamsPinned)
ponder.on('programSnapshot:CheckpointParamsPinned', onCheckpointParamsPinned)
ponder.on(
  'compositionMerkleSnapshot:CheckpointParamsPinned',
  onCheckpointParamsPinned
)
ponder.on(
  'contributionsMerkleSnapshot:CheckpointParamsPinned',
  onCheckpointParamsPinned
)

/**
 * `SnapshotTriggered` — the moment a checkpoint froze. Between this event and the matching
 * `MerkleProofSubmitted` the network is provably recounting, and the row's (blockNumber, logIndex)
 * is the fold-order boundary that splits "counted in this update" from "waits for the next one".
 * The `/network/:snapshot/status` route reads both to drive the app's pending-score states.
 */
const onSnapshotTriggered = async ({
  event,
  context,
}: SharedArgs<'merkleSnapshot:SnapshotTriggered'>) => {
  await context.db.insert(snapshotTrigger).values({
    id: event.id,
    snapshot: event.log.address,
    chainId: `${context.chain.id}`,
    checkpointId: event.args.checkpointId,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  })
}

ponder.on('merkleSnapshot:SnapshotTriggered', onSnapshotTriggered)
ponder.on('programSnapshot:SnapshotTriggered', onSnapshotTriggered)
ponder.on('weightedMerkleSnapshot:SnapshotTriggered', onSnapshotTriggered)
ponder.on('compositionMerkleSnapshot:SnapshotTriggered', onSnapshotTriggered)
ponder.on('contributionsMerkleSnapshot:SnapshotTriggered', onSnapshotTriggered)

ponder.on('merkleSnapshot:MerkleRootUpdated', onMerkleRootUpdated)
ponder.on('programSnapshot:MerkleRootUpdated', onMerkleRootUpdated)
ponder.on('weightedMerkleSnapshot:MerkleRootUpdated', onMerkleRootUpdated)
ponder.on('compositionMerkleSnapshot:MerkleRootUpdated', onMerkleRootUpdated)
ponder.on('contributionsMerkleSnapshot:MerkleRootUpdated', onMerkleRootUpdated)

async function insertMerkleData(
  scores: ScoreBlob,
  event: any,
  root: string,
  ipfsHash: string,
  ipfsHashCid: string,
  totalValue: bigint,
  provenance: ScoreProgramProvenance
) {
  // The blob is just { account: value }. Rebuild the OZ output tree exactly as the guest did (same
  // leaf/hash-pair encoding, ported in frontend/lib/pagerank/merkle) to recover each account's proof.
  let derived
  try {
    derived = deriveAddressMerkleRows(scores, root)
  } catch (error) {
    // Pinned blob doesn't reproduce the on-chain root — proofs would be useless. Surface it rather
    // than store bad data, but don't crash the whole indexer on one bad snapshot.
    console.warn(
      `merkle: ${error instanceof Error ? error.message : String(error)} for cid ${ipfsHashCid}; skipping entries`
    )
    derived = { computedRoot: null, rows: [] }
  }

  await offchainDb
    .insert(offchainSchema.merkleMetadata)
    .values({
      merkleSnapshotContract: event.log.address,
      root,
      ipfsHash,
      ipfsHashCid,
      numAccounts: Object.keys(scores).length,
      totalValue,
      sources: [],
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
      programId: provenance.programId,
      outputDomain: provenance.outputDomain,
      programProvenance: provenance,
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
        programId: sql.raw(
          `excluded."${offchainSchema.merkleMetadata.programId.name}"`
        ),
        outputDomain: sql.raw(
          `excluded."${offchainSchema.merkleMetadata.outputDomain.name}"`
        ),
        programProvenance: sql.raw(
          `excluded."${offchainSchema.merkleMetadata.programProvenance.name}"`
        ),
      },
    })

  // Skip entries if there are none, or if the recomputed root doesn't match (proofs would be wrong).
  if (derived.rows.length === 0) {
    return
  }

  await offchainDb
    .insert(offchainSchema.merkleEntry)
    .values(
      derived.rows.map(({ account, value, proof }) => ({
        merkleSnapshotContract: event.log.address,
        root,
        ipfsHashCid,
        account,
        value,
        proof,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        programId: provenance.programId,
        outputDomain: provenance.outputDomain,
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
        programId: sql.raw(
          `excluded."${offchainSchema.merkleEntry.programId.name}"`
        ),
        outputDomain: sql.raw(
          `excluded."${offchainSchema.merkleEntry.outputDomain.name}"`
        ),
      },
    })
}

/**
 * Read a distributor's configuration from chain state and write its config row. Used both by
 * `setup` (statically-addressed distributors) and lazily on the first event of a distributor whose
 * row is missing. Returns false when the contract has no code at this block — which is the normal
 * case at a `setup` that runs at block 1, and is harmless: the row is then created on the
 * distributor's first event instead (see `ensureDistributorConfig`).
 */
async function insertDistributorConfig(
  context: any,
  merkleFundDistributorAddress: Hex
): Promise<boolean> {
  try {
    // Static sources commonly begin before their contract was deployed. Checking code first avoids
    // nine expected `eth_call` failures (including getAllowlist, selector 0xc5eff3d0) and leaves the
    // lazy first-event path below to create the row at a block where the contract exists.
    const code = await context.client.getCode({
      address: merkleFundDistributorAddress,
    })
    if (!code || code === '0x') return false

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

    await context.db
      .insert(merkleFundDistributor)
      .values({
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
      .onConflictDoNothing()
    return true
  } catch {
    // Contract may not be deployed yet
    return false
  }
}

/**
 * Ensure a distributor's config row exists before updating it. A factory-created distributor gets
 * its row at birth from `InstanceCreated` (src/factory.ts) and a statically-addressed one from
 * `setup`, but neither is guaranteed: `setup` runs at the source's start block, where the contract
 * may not exist yet. Reading the state lazily at the event's own block makes an update-before-row
 * impossible instead of merely unlikely — the old failure mode was a `RecordNotFound` throw that
 * wedged the indexer until the whole local stack was restarted.
 */
async function ensureDistributorConfig(context: any, address: Hex) {
  const existing = await context.db.find(merkleFundDistributor, { address })
  if (existing) return existing
  await insertDistributorConfig(context, address)
  return await context.db.find(merkleFundDistributor, { address })
}

/** Ensure-then-update, the shape every config-change handler below wants. */
async function updateDistributorConfig(
  context: any,
  address: Hex,
  set: Record<string, unknown>
) {
  await ensureDistributorConfig(context, address)
  await context.db.update(merkleFundDistributor, { address }).set(set)
}

ponder.on('merkleFundDistributor:setup', async ({ context }) => {
  for (const address of staticAddresses(
    context.contracts.merkleFundDistributor.address
  )) {
    await insertDistributorConfig(context, address)
  }
})

ponder.on('programFundDistributor:setup', async ({ context }) => {
  for (const address of staticAddresses(
    context.contracts.programFundDistributor.address
  )) {
    await insertDistributorConfig(context, address)
  }
})

// Factory-discovered round distributors get their row at birth from the creation event
// (src/contributions-factory.ts); this setup is the same static-list no-op the other factory
// sources have, kept for shape parity.
ponder.on('contributionsFundDistributor:setup', async ({ context }) => {
  for (const address of staticAddresses(
    context.contracts.contributionsFundDistributor.address
  )) {
    await insertDistributorConfig(context, address)
  }
})

const onOwnershipTransferStarted = async ({
  event,
  context,
}: SharedArgs<'merkleFundDistributor:OwnershipTransferStarted'>) => {
  const { pendingOwner } = event.args
  await updateDistributorConfig(context, event.log.address, { pendingOwner })
}

const onOwnershipTransferred = async ({
  event,
  context,
}: SharedArgs<'merkleFundDistributor:OwnershipTransferred'>) => {
  const { newOwner } = event.args
  await updateDistributorConfig(context, event.log.address, {
    owner: newOwner,
    pendingOwner: '0x0000000000000000000000000000000000000000',
  })
}

const onFeeRecipientSet = async ({
  event,
  context,
}: SharedArgs<'merkleFundDistributor:FeeRecipientSet'>) => {
  const { newFeeRecipient } = event.args
  await updateDistributorConfig(context, event.log.address, {
    feeRecipient: newFeeRecipient,
  })
}

const onFeePercentageSet = async ({
  event,
  context,
}: SharedArgs<'merkleFundDistributor:FeePercentageSet'>) => {
  const { newFeePercentage } = event.args
  // Read FEE_RANGE to calculate the percentage
  const feeRange = await context.client.readContract({
    address: event.log.address,
    abi: merkleFundDistributorAbi,
    functionName: 'FEE_RANGE',
  })
  await updateDistributorConfig(context, event.log.address, {
    feePercentage: (Number(newFeePercentage) / Number(feeRange)).toString(),
  })
}

const onMerkleSnapshotUpdated = async ({
  event,
  context,
}: SharedArgs<'merkleFundDistributor:MerkleSnapshotUpdated'>) => {
  const { newContract } = event.args
  await updateDistributorConfig(context, event.log.address, {
    merkleSnapshot: newContract,
  })
}

const onDistributorAllowanceUpdated = async ({
  event,
  context,
}: SharedArgs<'merkleFundDistributor:DistributorAllowanceUpdated'>) => {
  const { distributor, canDistribute } = event.args
  // Read the current allowlist and update it
  const current = await ensureDistributorConfig(context, event.log.address)
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
    newAllowlist = current.allowlist.filter((addr: Hex) => addr !== distributor)
  }

  await context.db
    .update(merkleFundDistributor, { address: event.log.address })
    .set({
      allowlist: newAllowlist,
    })
}

const onDistributorAllowlistUpdated = async ({
  event,
  context,
}: SharedArgs<'merkleFundDistributor:DistributorAllowlistUpdated'>) => {
  const { enabled } = event.args
  await updateDistributorConfig(context, event.log.address, {
    allowlistEnabled: enabled,
  })
}

const onPaused = async ({
  event,
  context,
}: SharedArgs<'merkleFundDistributor:Paused'>) => {
  await updateDistributorConfig(context, event.log.address, { paused: true })
}

const onUnpaused = async ({
  event,
  context,
}: SharedArgs<'merkleFundDistributor:Unpaused'>) => {
  await updateDistributorConfig(context, event.log.address, { paused: false })
}

/**
 * Ensure the distribution row exists, backfilling it from contract state when the Distributed
 * event was never seen (an indexer whose start block is above the funding block — the ordinary
 * case on a mainnet fork, where PONDER_START_BLOCK is the fork block).
 */
async function ensureDistribution(
  context: any,
  distributorAddress: `0x${string}`,
  distributionIndex: bigint
) {
  const existing = await context.db.find(merkleFundDistribution, {
    merkleFundDistributor: distributorAddress,
    id: distributionIndex,
  })
  if (existing) return existing

  const distribution = await context.client.readContract({
    address: distributorAddress,
    abi: merkleFundDistributorAbi,
    functionName: 'getDistribution',
    args: [distributionIndex],
  })
  return await context.db
    .insert(merkleFundDistribution)
    .values({
      id: distributionIndex,
      merkleFundDistributor: distributorAddress,
      blockNumber: BigInt(distribution.blockNumber),
      timestamp: BigInt(distribution.timestamp),
      root: distribution.root,
      ipfsHash: distribution.ipfsHash,
      ipfsHashCid: distribution.ipfsHashCid,
      totalMerkleValue: distribution.totalMerkleValue,
      distributor: distribution.distributor,
      token: distribution.token,
      amountFunded: distribution.amountFunded,
      amountDistributed: distribution.amountDistributed,
      feeRecipient: distribution.feeRecipient,
      feeAmount: distribution.feeAmount,
      claimDeadline: BigInt(distribution.claimDeadline),
      sweptAmount: distribution.sweptAmount,
      sweptTo: null,
      sweptAt: null,
    })
    .onConflictDoNothing()
}

const onDistributed = async ({
  event,
  context,
}: SharedArgs<'merkleFundDistributor:Distributed'>) => {
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
    claimDeadline: distribution.claimDeadline,
    sweptAmount: 0n,
    sweptTo: null,
    sweptAt: null,
  })
}

// M6 expiry + sweep: the funder reclaimed the unclaimed remainder after the claim deadline.
const onSwept = async ({
  event,
  context,
}: SharedArgs<'merkleFundDistributor:Swept'>) => {
  const { distributionIndex, to, amount } = event.args
  await ensureDistribution(context, event.log.address, distributionIndex)
  await context.db
    .update(merkleFundDistribution, {
      merkleFundDistributor: event.log.address,
      id: distributionIndex,
    })
    .set({
      sweptAmount: amount,
      sweptTo: to,
      sweptAt: event.block.timestamp,
    })
}

const onClaimed = async ({
  event,
  context,
}: SharedArgs<'merkleFundDistributor:Claimed'>) => {
  const {
    distributionIndex,
    account,
    token,
    amount,
    value,
    newAmountDistributed,
  } = event.args

  // Update the distribution's amountDistributed (backfilling the row if the Distributed event
  // was never seen — see ensureDistribution).
  await ensureDistribution(context, event.log.address, distributionIndex)
  await context.db
    .update(merkleFundDistribution, {
      merkleFundDistributor: event.log.address,
      id: distributionIndex,
    })
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
}

/*///////////////////////////////////////////////////////////////
   Distributor handlers, registered on BOTH distributor sources
//////////////////////////////////////////////////////////////*/

ponder.on(
  'merkleFundDistributor:OwnershipTransferStarted',
  onOwnershipTransferStarted
)
ponder.on(
  'programFundDistributor:OwnershipTransferStarted',
  onOwnershipTransferStarted
)
ponder.on('merkleFundDistributor:OwnershipTransferred', onOwnershipTransferred)
ponder.on('programFundDistributor:OwnershipTransferred', onOwnershipTransferred)
ponder.on('merkleFundDistributor:FeeRecipientSet', onFeeRecipientSet)
ponder.on('programFundDistributor:FeeRecipientSet', onFeeRecipientSet)
ponder.on('merkleFundDistributor:FeePercentageSet', onFeePercentageSet)
ponder.on('programFundDistributor:FeePercentageSet', onFeePercentageSet)
ponder.on(
  'merkleFundDistributor:MerkleSnapshotUpdated',
  onMerkleSnapshotUpdated
)
ponder.on(
  'programFundDistributor:MerkleSnapshotUpdated',
  onMerkleSnapshotUpdated
)
ponder.on(
  'merkleFundDistributor:DistributorAllowanceUpdated',
  onDistributorAllowanceUpdated
)
ponder.on(
  'programFundDistributor:DistributorAllowanceUpdated',
  onDistributorAllowanceUpdated
)
ponder.on(
  'merkleFundDistributor:DistributorAllowlistUpdated',
  onDistributorAllowlistUpdated
)
ponder.on(
  'programFundDistributor:DistributorAllowlistUpdated',
  onDistributorAllowlistUpdated
)
ponder.on('merkleFundDistributor:Paused', onPaused)
ponder.on('programFundDistributor:Paused', onPaused)
ponder.on('merkleFundDistributor:Unpaused', onUnpaused)
ponder.on('programFundDistributor:Unpaused', onUnpaused)
ponder.on('merkleFundDistributor:Distributed', onDistributed)
ponder.on('programFundDistributor:Distributed', onDistributed)
ponder.on('merkleFundDistributor:Swept', onSwept)
ponder.on('programFundDistributor:Swept', onSwept)
ponder.on('merkleFundDistributor:Claimed', onClaimed)
ponder.on('programFundDistributor:Claimed', onClaimed)

// Factory-discovered contributions-round distributors: the same handlers, third source.
ponder.on(
  'contributionsFundDistributor:OwnershipTransferStarted',
  onOwnershipTransferStarted
)
ponder.on(
  'contributionsFundDistributor:OwnershipTransferred',
  onOwnershipTransferred
)
ponder.on('contributionsFundDistributor:FeeRecipientSet', onFeeRecipientSet)
ponder.on('contributionsFundDistributor:FeePercentageSet', onFeePercentageSet)
ponder.on(
  'contributionsFundDistributor:MerkleSnapshotUpdated',
  onMerkleSnapshotUpdated
)
ponder.on(
  'contributionsFundDistributor:DistributorAllowanceUpdated',
  onDistributorAllowanceUpdated
)
ponder.on(
  'contributionsFundDistributor:DistributorAllowlistUpdated',
  onDistributorAllowlistUpdated
)
ponder.on('contributionsFundDistributor:Paused', onPaused)
ponder.on('contributionsFundDistributor:Unpaused', onUnpaused)
ponder.on('contributionsFundDistributor:Distributed', onDistributed)
ponder.on('contributionsFundDistributor:Swept', onSwept)
ponder.on('contributionsFundDistributor:Claimed', onClaimed)
