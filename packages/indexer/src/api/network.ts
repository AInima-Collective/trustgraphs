import { and, asc, count, desc, eq, gt, inArray, lt, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from 'ponder:api'
import {
  accumulatorRecord,
  easAttestation,
  easOffchainAnchor,
  easOffchainMutation,
  easOffchainNode,
  erc8004Agent,
  instance,
  merkleSnapshot,
  proofSubmission,
  snapshotTrigger,
} from 'ponder:schema'
import { Hex, isAddress } from 'viem'

import { offchainDb } from './db'
import {
  ScoreProgramApiError,
  requireEntryScoreProgram,
  requireRowScoreProgram,
  requireSnapshotScoreProgram,
} from './score-programs'
import { EAS_NETWORKS as NETWORKS, isHexEqual, lower } from './utils'
import { currentTimedVouches } from '../trust-reconcile'

const app = new Hono()
const ZERO32 = `0x${'0'.repeat(64)}` as Hex

class StrictLaneApiError extends Error {}

const requireTrustNetworkProgram = async (snapshot: string) => {
  const scoreProgram = await requireSnapshotScoreProgram(snapshot, 'merkle')
  if (
    scoreProgram.programName !== 'trust-graph' &&
    scoreProgram.programName !== 'trust-graph-weighted'
  ) {
    throw new ScoreProgramApiError(
      `${scoreProgram.programName} scores are not a vouch-network API type`
    )
  }
  return scoreProgram
}

// Get the accounts and attestations that are part of the network defined by the Merkle Snapshot contract.
/**
 * The vouch schema UIDs to attribute attestations to, for one snapshot.
 *
 * Two sources, in order: the build-time config (hand-deployed networks, and the program-tagged
 * entries this route deliberately ignores), then the `instance` table — the catalog of everything
 * `TrustgraphsFactory` created. Without the second lookup a factory network 404s here, which is not
 * a cosmetic failure: it is exactly the endpoint the network page reads its member list and
 * attestation feed from, so a freshly created community would render its name and a vouch button
 * over a permanently empty roster.
 */
const schemaUidsForSnapshot = async (
  merkleSnapshotContract: string
): Promise<Hex[] | null> => {
  const configured = NETWORKS.find((network) =>
    isHexEqual(network.contracts.merkleSnapshot, merkleSnapshotContract)
  )
  // `demo:govern` adds presentation/governance data for the factory-created
  // demo to the static catalog before it knows the instance schema. An empty
  // `schemas` array is therefore not an authoritative "no schemas" result:
  // fall through to the on-chain factory catalog, or every indexed vouch is
  // excluded by the empty `inArray` below and the graph appears blank.
  if (configured && configured.schemas.length > 0) {
    return configured.schemas.map((schema) => schema.uid as Hex)
  }

  const row = await db
    .select({ schemaUid: instance.schemaUid })
    .from(instance)
    .where(eq(instance.snapshot, merkleSnapshotContract.toLowerCase() as Hex))
    .limit(1)
  return row.length > 0 ? [row[0]!.schemaUid as Hex] : null
}

/** Resolve the lane-1 fold log for config-backed and factory-created networks alike. */
const resolverForSnapshot = async (snapshot: string): Promise<Hex | null> => {
  const configured = NETWORKS.find((network) =>
    isHexEqual(network.contracts.merkleSnapshot, snapshot)
  )
  const configuredResolver = (
    configured?.contracts as { easIndexerResolver?: string } | undefined
  )?.easIndexerResolver
  if (configuredResolver) return configuredResolver.toLowerCase() as Hex

  const [row] = await db
    .select({ resolver: instance.resolver })
    .from(instance)
    .where(eq(instance.snapshot, snapshot.toLowerCase() as Hex))
    .limit(1)
  return (row?.resolver as Hex | undefined) ?? null
}

app.get('/:snapshot', async (c) => {
  const merkleSnapshotContract = c.req.param('snapshot')
  const schemaUids = await schemaUidsForSnapshot(merkleSnapshotContract)
  if (!schemaUids) {
    return c.json(
      { error: 'Network not found for MerkleSnapshot contract' },
      404
    )
  }

  try {
    const currentScoreProgram = await requireTrustNetworkProgram(
      merkleSnapshotContract
    )
    const latestMerkleTree = await offchainDb.query.merkleMetadata.findFirst({
      where: (t, { eq }) =>
        eq(
          lower(t.merkleSnapshotContract),
          merkleSnapshotContract.toLowerCase()
        ),
      orderBy: (t, { desc }) => desc(t.timestamp),
    })
    if (!latestMerkleTree) {
      return c.json({ error: 'Merkle tree not found' }, 404)
    }
    const scoreProgram = requireRowScoreProgram(
      latestMerkleTree,
      currentScoreProgram,
      'merkle'
    )

    const allAccounts = await offchainDb.query.merkleEntry.findMany({
      columns: {
        account: true,
        value: true,
        programId: true,
        outputDomain: true,
      },
      where: (t, { eq, gt, and }) =>
        and(
          eq(
            lower(t.merkleSnapshotContract),
            merkleSnapshotContract.toLowerCase()
          ),
          eq(lower(t.root), latestMerkleTree.root.toLowerCase()),
          gt(t.value, 0n)
        ),
      orderBy: (t, { asc }) => asc(t.account),
    })
    for (const account of allAccounts) {
      requireEntryScoreProgram(account, currentScoreProgram)
    }

    // Map of in-network accounts to their metadata.
    const accountsMap: Map<
      string,
      {
        value: bigint
        sent: number
        received: number
      }
    > = new Map()
    for (const account of allAccounts) {
      accountsMap.set(account.account, {
        value: account.value,
        sent: 0,
        received: 0,
      })
    }

    const relevantAccounts = Array.from(accountsMap.keys()) as `0x${string}`[]
    const resolver = await resolverForSnapshot(merkleSnapshotContract)
    if (!resolver) return c.json({ error: 'Network resolver not found' }, 404)
    const foldRows = await db
      .select({
        kind: accumulatorRecord.kind,
        attester: accumulatorRecord.attester,
        recipient: accumulatorRecord.recipient,
        uid: accumulatorRecord.uid,
        data: accumulatorRecord.data,
        blockTimestamp: accumulatorRecord.blockTimestamp,
        blockNumber: accumulatorRecord.blockNumber,
        logIndex: accumulatorRecord.logIndex,
        txHash: accumulatorRecord.txHash,
      })
      .from(accumulatorRecord)
      .where(eq(accumulatorRecord.accumulator, resolver))
      .orderBy(
        asc(accumulatorRecord.blockNumber),
        asc(accumulatorRecord.logIndex)
      )
    const [catalogInstance] = await db
      .select({
        offchainRegistry: instance.offchainRegistry,
        schemaUid: instance.schemaUid,
      })
      .from(instance)
      .where(eq(instance.snapshot, merkleSnapshotContract.toLowerCase() as Hex))
      .limit(1)
    const strictRegistry = catalogInstance?.offchainRegistry
    const strictRows: Array<{
      kind: number
      attester: Hex
      recipient: Hex
      uid: Hex
      data: Hex
      timestamp: bigint
      signedTime: bigint
      sourceLane: 1
      sourceOrder: bigint
      sourceSuborder: number
      registry: Hex
      nodeId: Hex
      head: Hex
      count: bigint
      dataCommitment: Hex
      cid: string
      anchorTxHash: Hex
      anchorBlock: bigint
      anchorTimestamp: bigint
      firstAnchorTxHash: Hex
      firstAnchorBlock: bigint
      firstAnchorTimestamp: bigint
      gatewayIndex: number | null
      fetchLatencyMs: number | null
    }> = []

    if (strictRegistry) {
      const nodes = await db
        .select()
        .from(easOffchainNode)
        .where(eq(easOffchainNode.registry, strictRegistry))
      const invalid = nodes.find((node) => !node.verified)
      if (invalid) {
        throw new StrictLaneApiError(
          `Strict node ${invalid.nodeId} is unavailable or invalid (${invalid.validationError ?? 'E0_VALIDATION'})`
        )
      }

      const anchorIds = nodes.map((node) => node.anchorId)
      const [mutations, anchors] =
        anchorIds.length === 0
          ? [[], []]
          : await Promise.all([
              db
                .select()
                .from(easOffchainMutation)
                .where(inArray(easOffchainMutation.anchorId, anchorIds)),
              db
                .select()
                .from(easOffchainAnchor)
                .where(inArray(easOffchainAnchor.id, anchorIds)),
            ])
      const mutationsByAnchor = new Map<string, number>()
      for (const mutation of mutations) {
        mutationsByAnchor.set(
          mutation.anchorId,
          (mutationsByAnchor.get(mutation.anchorId) ?? 0) + 1
        )
      }
      for (const node of nodes) {
        if (BigInt(mutationsByAnchor.get(node.anchorId) ?? 0) !== node.count) {
          throw new StrictLaneApiError(
            `Strict node ${node.nodeId} has an incomplete derived mutation log`
          )
        }
      }

      const nodesByAnchor = new Map(nodes.map((node) => [node.anchorId, node]))
      const anchorsById = new Map(anchors.map((anchor) => [anchor.id, anchor]))
      for (const mutation of mutations) {
        const node = nodesByAnchor.get(mutation.anchorId)
        const anchor = anchorsById.get(mutation.anchorId)
        if (!node || !anchor?.verified) {
          throw new StrictLaneApiError(
            `Strict mutation ${mutation.id} lacks a verified current anchor`
          )
        }
        strictRows.push({
          kind: mutation.kind,
          attester: node.owner,
          recipient: mutation.recipient,
          uid: mutation.uid,
          data: mutation.data,
          timestamp: mutation.time,
          signedTime: mutation.signedTime,
          sourceLane: 1,
          sourceOrder: mutation.firstAnchorFoldIndex,
          sourceSuborder: mutation.sequence,
          registry: strictRegistry,
          nodeId: node.nodeId,
          head: node.head,
          count: node.count,
          dataCommitment: node.dataCommitment,
          cid: node.cid,
          anchorTxHash: node.updatedTxHash,
          anchorBlock: node.updatedBlock,
          anchorTimestamp: node.updatedTimestamp,
          firstAnchorTxHash: mutation.firstAnchorTxHash,
          firstAnchorBlock: mutation.firstAnchorBlock,
          firstAnchorTimestamp: mutation.firstAnchorTimestamp,
          gatewayIndex: anchor.gatewayIndex,
          fetchLatencyMs: anchor.fetchLatencyMs,
        })
      }
    }

    const lane1Rows = foldRows.map((row) => ({
      ...row,
      timestamp: row.blockTimestamp,
      sourceLane: 0 as const,
      sourceOrder: row.blockNumber,
      sourceSuborder: row.logIndex,
    }))
    const currentRows = currentTimedVouches([
      ...lane1Rows,
      ...strictRows,
    ]).filter(
      (row) =>
        accountsMap.has(row.attester) &&
        accountsMap.has(row.recipient) &&
        row.attester !== row.recipient
    )
    const currentLane1 = currentRows.filter(
      (row): row is (typeof lane1Rows)[number] => row.sourceLane === 0
    )
    const currentLane1Uids = currentLane1.map((row) => row.uid)
    const onchainAttestations =
      currentLane1Uids.length === 0
        ? []
        : await db
            .select()
            .from(easAttestation)
            .where(
              and(
                inArray(easAttestation.uid, currentLane1Uids),
                inArray(easAttestation.schema, schemaUids),
                inArray(easAttestation.attester, relevantAccounts),
                inArray(easAttestation.recipient, relevantAccounts)
              )
            )
            .orderBy(
              asc(easAttestation.attester),
              asc(easAttestation.recipient)
            )

    const lane1ByUid = new Map(
      currentLane1.map((row) => [row.uid.toLowerCase(), row])
    )
    const hybrid = Boolean(strictRegistry)
    const attestations = [
      ...onchainAttestations.map((attestation) => {
        if (!hybrid) return attestation
        const fold = lane1ByUid.get(attestation.uid.toLowerCase())
        return {
          ...attestation,
          provenance: {
            source: 'on-chain-eas',
            transactionHash: fold?.txHash ?? null,
            blockNumber: fold?.blockNumber.toString() ?? null,
          },
        }
      }),
      ...currentRows
        .filter(
          (row): row is (typeof strictRows)[number] => row.sourceLane === 1
        )
        .map((row) => ({
          uid: row.uid,
          schema: catalogInstance!.schemaUid,
          resolver: strictRegistry!,
          attester: row.attester,
          recipient: row.recipient,
          ref: ZERO32,
          revocable: true,
          expirationTime: 0n,
          revocationTime: 0n,
          data: row.data,
          blockNumber: row.firstAnchorBlock,
          timestamp: row.signedTime,
          provenance: {
            source: 'off-chain-eas',
            registry: row.registry,
            nodeId: row.nodeId,
            head: row.head,
            count: row.count.toString(),
            dataCommitment: row.dataCommitment,
            cid: row.cid,
            anchorTransactionHash: row.anchorTxHash,
            anchorBlock: row.anchorBlock.toString(),
            anchorTimestamp: row.anchorTimestamp.toString(),
            firstCommitTransactionHash: row.firstAnchorTxHash,
            firstCommitBlock: row.firstAnchorBlock.toString(),
            firstCommitTimestamp: row.firstAnchorTimestamp.toString(),
            storageHealthy: true,
            indexerVerified: true,
            gatewayIndex: row.gatewayIndex,
            fetchLatencyMs: row.fetchLatencyMs,
            revocation: 'Trustgraphs in-log only',
          },
        })),
    ].sort(
      (a, b) =>
        a.attester.localeCompare(b.attester) ||
        a.recipient.localeCompare(b.recipient)
    )

    for (const attestation of attestations) {
      accountsMap.get(attestation.attester)!.sent++
      accountsMap.get(attestation.recipient)!.received++
    }

    // One bulk reverse lookup decorates the existing address graph. It does not change member
    // inclusion, scores, vouches, roots, or proofs; it only exposes current verified-wallet links.
    const agentRows =
      relevantAccounts.length === 0
        ? []
        : await db
            .select()
            .from(erc8004Agent)
            .where(inArray(erc8004Agent.agentWallet, relevantAccounts))
            .orderBy(
              asc(erc8004Agent.chainId),
              asc(erc8004Agent.registry),
              asc(erc8004Agent.agentId)
            )
    const agentsByWallet = new Map<
      string,
      Array<{
        key: string
        chainId: string
        registry: Hex
        agentId: string
        owner: Hex | null
      }>
    >()
    for (const agent of agentRows) {
      if (!agent.agentWallet) continue
      const agents = agentsByWallet.get(agent.agentWallet) ?? []
      agents.push({
        key: agent.id,
        chainId: agent.chainId,
        registry: agent.registry,
        agentId: agent.agentId.toString(),
        owner: agent.owner,
      })
      agentsByWallet.set(agent.agentWallet, agents)
    }

    const accounts = Array.from(accountsMap)
      .map(([account, { value, sent, received }]) => ({
        account,
        value: value.toString(),
        sent,
        received,
        agents: agentsByWallet.get(account.toLowerCase()) ?? [],
      }))
      .sort((a, b) => a.account.localeCompare(b.account))

    return c.json({
      accounts,
      attestations,
      scoreProgram,
    })
  } catch (error) {
    if (error instanceof StrictLaneApiError) {
      return c.json({ error: error.message, code: 'E0_INDEXER_STATE' }, 409)
    }
    if (error instanceof ScoreProgramApiError) {
      return c.json({ error: error.message }, 409)
    }
    console.error('Error fetching network:', error)
    return c.json({ error: 'Failed to fetch network' }, 500)
  }
})

/**
 * Exact fold-ordered lane-1 inputs frozen by a named checkpoint.
 *
 * This is deliberately checkpoint-addressed instead of returning a convenient "current graph":
 * the Settings preview must be able to name and reproduce the input cutoff it compares. The
 * browser recomputes the accumulator and compares it with `resolver.getCheckpoint(id)` from RPC;
 * a missing row therefore becomes an unavailable preview, never a guessed one.
 */
app.get('/:snapshot/checkpoints/:checkpointId/inputs', async (c) => {
  const snapshot = c.req.param('snapshot')
  const checkpointRaw = c.req.param('checkpointId')
  if (!isAddress(snapshot)) {
    return c.json({ error: 'snapshot must be an address' }, 400)
  }
  if (!/^\d+$/.test(checkpointRaw)) {
    return c.json({ error: 'checkpointId must be a non-negative integer' }, 400)
  }

  try {
    const scoreProgram = await requireTrustNetworkProgram(snapshot)
    const checkpointId = BigInt(checkpointRaw)
    const resolver = await resolverForSnapshot(snapshot)
    if (!resolver) return c.json({ error: 'Network not found' }, 404)

    const [trigger] = await db
      .select()
      .from(snapshotTrigger)
      .where(
        and(
          eq(snapshotTrigger.snapshot, snapshot.toLowerCase() as Hex),
          eq(snapshotTrigger.checkpointId, checkpointId)
        )
      )
      .limit(1)
    if (!trigger) return c.json({ error: 'Checkpoint not found' }, 404)

    const rows = await db
      .select({
        kind: accumulatorRecord.kind,
        attester: accumulatorRecord.attester,
        recipient: accumulatorRecord.recipient,
        uid: accumulatorRecord.uid,
        data: accumulatorRecord.data,
        blockTimestamp: accumulatorRecord.blockTimestamp,
        blockNumber: accumulatorRecord.blockNumber,
        logIndex: accumulatorRecord.logIndex,
        txHash: accumulatorRecord.txHash,
      })
      .from(accumulatorRecord)
      .where(
        and(
          eq(accumulatorRecord.accumulator, resolver),
          or(
            lt(accumulatorRecord.blockNumber, trigger.blockNumber),
            and(
              eq(accumulatorRecord.blockNumber, trigger.blockNumber),
              lt(accumulatorRecord.logIndex, trigger.logIndex)
            )
          )
        )
      )
      .orderBy(
        asc(accumulatorRecord.blockNumber),
        asc(accumulatorRecord.logIndex)
      )

    return c.json({
      snapshot: snapshot.toLowerCase(),
      accumulator: resolver,
      checkpointId: checkpointId.toString(),
      cutoff: {
        blockNumber: trigger.blockNumber.toString(),
        logIndex: trigger.logIndex,
        timestamp: trigger.timestamp.toString(),
        transactionHash: trigger.txHash,
      },
      inputs: rows.map((row) => ({
        ...row,
        blockTimestamp: row.blockTimestamp.toString(),
        blockNumber: row.blockNumber.toString(),
      })),
      scoreProgram,
    })
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return c.json({ error: error.message }, 409)
    }
    console.error('Error fetching checkpoint inputs:', error)
    return c.json({ error: 'Failed to fetch checkpoint inputs' }, 500)
  }
})

/**
 * The pending-score state the app shows between "attestation saved" and "scores updated": the
 * last landed update, whether a recount is running right now, and how many attestations await the
 * next one. Read from chain events alone (SnapshotTriggered / MerkleProofSubmitted / the
 * accumulator's fold markers), never from an operator's self-report — any prover's work produces
 * the same states.
 */
app.get('/:snapshot/status', async (c) => {
  const snapshot = c.req.param('snapshot').toLowerCase() as Hex

  try {
    const scoreProgram = await requireTrustNetworkProgram(snapshot)
    const [lastRoot] = await db
      .select({
        root: merkleSnapshot.root,
        blockNumber: merkleSnapshot.blockNumber,
        timestamp: merkleSnapshot.timestamp,
      })
      .from(merkleSnapshot)
      .where(eq(merkleSnapshot.address, snapshot))
      .orderBy(desc(merkleSnapshot.blockNumber))
      .limit(1)

    const [lastProof] = await db
      .select()
      .from(proofSubmission)
      .where(eq(proofSubmission.snapshot, snapshot))
      .orderBy(desc(proofSubmission.checkpointId))
      .limit(1)

    const [lastTrigger] = await db
      .select()
      .from(snapshotTrigger)
      .where(eq(snapshotTrigger.snapshot, snapshot))
      .orderBy(desc(snapshotTrigger.checkpointId))
      .limit(1)

    // A trigger newer than the last applied proof means inputs are frozen and a proof is being
    // computed (or owed). With no proof at all, any trigger means the first recount is running.
    const recounting =
      lastTrigger &&
      (!lastProof || lastTrigger.checkpointId > lastProof.checkpointId)
        ? lastTrigger
        : null

    // Folds past the applied checkpoint's freeze boundary are attestations the served scores do
    // not include yet. Needs the network's accumulator: the build-time config first (hand-deployed
    // networks carry `easIndexerResolver`), then the factory catalog — the same two sources as
    // `schemaUidsForSnapshot`, in the same order.
    let pendingAttestations: number | null = null
    const resolver = await resolverForSnapshot(snapshot)

    if (resolver) {
      // The boundary is the applied checkpoint's own trigger row. A proof whose trigger predates
      // the indexer's start has no boundary to count from, so the count stays null rather than
      // guessing.
      const boundary = lastProof
        ? lastProof.checkpointId === lastTrigger?.checkpointId
          ? lastTrigger
          : (
              await db
                .select()
                .from(snapshotTrigger)
                .where(
                  and(
                    eq(snapshotTrigger.snapshot, snapshot),
                    eq(snapshotTrigger.checkpointId, lastProof.checkpointId)
                  )
                )
                .limit(1)
            )[0]
        : undefined

      if (!lastProof || boundary) {
        const [pending] = await db
          .select({ value: count() })
          .from(accumulatorRecord)
          .where(
            and(
              eq(accumulatorRecord.accumulator, resolver.toLowerCase() as Hex),
              boundary
                ? or(
                    gt(accumulatorRecord.blockNumber, boundary.blockNumber),
                    and(
                      eq(accumulatorRecord.blockNumber, boundary.blockNumber),
                      gt(accumulatorRecord.logIndex, boundary.logIndex)
                    )
                  )
                : undefined
            )
          )
        pendingAttestations = pending?.value ?? null
      }
    }

    return c.json({
      lastUpdate: lastRoot
        ? {
            root: lastRoot.root,
            timestamp: Number(lastRoot.timestamp),
            blockNumber: lastRoot.blockNumber.toString(),
            checkpointId: lastProof ? lastProof.checkpointId.toString() : null,
          }
        : null,
      recounting: recounting
        ? {
            checkpointId: recounting.checkpointId.toString(),
            since: Number(recounting.timestamp),
          }
        : null,
      pendingAttestations,
      scoreProgram,
    })
  } catch (error) {
    if (error instanceof ScoreProgramApiError) {
      return c.json({ error: error.message }, 409)
    }
    console.error('Error fetching network status:', error)
    return c.json({ error: 'Failed to fetch network status' }, 500)
  }
})

export default app
