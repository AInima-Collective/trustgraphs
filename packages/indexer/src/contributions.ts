import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { ponder } from 'ponder:registry'
import {
  accumulatorRecord,
  contributionClaim,
  contributionClaimContributor,
  contributionResponse,
  contributionValuation,
  contributionsInstance,
  contributionsParameterVersion,
} from 'ponder:schema'
import { type Hex, decodeAbiParameters, decodeFunctionData } from 'viem'

import * as offchainSchema from '../offchain.schema'
import { offchainDb } from './api/db'
import {
  applyDiscountStatus,
  contributionsParamsHash,
  deriveAudit,
  deriveScores,
  paramsSnapshot,
  parseParamsSnapshot,
  rowsToRawEdges,
} from './contributions-shared'
import type { ScoreProgramProvenance } from './score-program'
import { SCORE_OUTPUT_DOMAIN_IDS } from './score-program'
import {
  easAbi,
  merkleSnapshotAbi,
  trustAccumulatorMirrorAbi,
} from '../../frontend/lib/contract-abis'
import {
  computeContributions,
  decodeClaim,
  decodeResponse,
  decodeValuation,
} from '../../frontend/lib/contributions'
import { accumulate } from '../../frontend/lib/pagerank/encode'

/**
 * Contributions-program handlers (`research/operations/contributions/interfaces.md`).
 *
 * Two jobs:
 *  1. Index the ContributionResolver's fold log (every attestation/revocation across the three
 *     schemas, kinds 0–5) into `accumulator_record` + the decoded per-schema tables — the display
 *     mirror of exactly what the guest consumes.
 *  2. On the contributions `MerkleSnapshot.MerkleRootUpdated`, re-derive the full two-stage
 *     scoring from those indexed rows (truncated to the checkpointed leaf counts) and only publish
 *     per-claim scores + the valuation audit when the recomputed output root equals the proven
 *     on-chain root (`ingestContributionsScores`, called from src/merkle.ts — the
 *     `ingestHypercertsScores` pattern). Display validation, never a second source of truth.
 */

/*///////////////////////////////////////////////////////////////
          Resolver fold-log + decoded record handlers
//////////////////////////////////////////////////////////////*/

/** Cached (per resolver address) schema-UID allowlist, read once from chain. */
const schemaIndexCache = new Map<string, Map<string, number>>()

const schemaIndexOf = async (
  context: any,
  resolver: Hex,
  schemaUid: Hex
): Promise<number | null> => {
  const key = resolver.toLowerCase()
  let map = schemaIndexCache.get(key)
  if (!map) {
    const abi = [
      {
        type: 'function',
        name: 'claimSchemaUid',
        inputs: [],
        outputs: [{ type: 'bytes32' }],
        stateMutability: 'view',
      },
      {
        type: 'function',
        name: 'responseSchemaUid',
        inputs: [],
        outputs: [{ type: 'bytes32' }],
        stateMutability: 'view',
      },
      {
        type: 'function',
        name: 'valuationSchemaUid',
        inputs: [],
        outputs: [{ type: 'bytes32' }],
        stateMutability: 'view',
      },
    ] as const
    const [claimUid, responseUid, valuationUid] = await Promise.all([
      context.client.readContract({
        address: resolver,
        abi,
        functionName: 'claimSchemaUid',
      }),
      context.client.readContract({
        address: resolver,
        abi,
        functionName: 'responseSchemaUid',
      }),
      context.client.readContract({
        address: resolver,
        abi,
        functionName: 'valuationSchemaUid',
      }),
    ])
    map = new Map([
      [(claimUid as string).toLowerCase(), 0],
      [(responseUid as string).toLowerCase(), 1],
      [(valuationUid as string).toLowerCase(), 2],
    ])
    schemaIndexCache.set(key, map)
  }
  return map.get(schemaUid.toLowerCase()) ?? null
}

/** ABI of the claim payload for display decoding (title/uri; validity comes from decodeClaim). */
const CLAIM_PAYLOAD_ABI = [
  { type: 'string', name: 'title' },
  { type: 'bytes32', name: 'contentHash' },
  { type: 'string', name: 'uri' },
  { type: 'address[]', name: 'contributors' },
  { type: 'uint32[]', name: 'shares' },
] as const

/**
 * Recompute the `superseded` flags for one (resolver, claim, actor) key: among well-formed,
 * non-revoked records, the latest by (blockTimestamp, blockNumber, logIndex) is live and every
 * other one is superseded — the guest's exact last-write-wins order (fold order == chain order).
 * Revoking the latest record therefore un-supersedes its predecessor.
 */
const recomputeSuperseded = async (
  context: any,
  table: typeof contributionResponse | typeof contributionValuation,
  actorColumn: 'responder' | 'rater',
  resolver: Hex,
  claimUid: Hex,
  actor: Hex
) => {
  const rows: any[] = await context.db.sql
    .select()
    .from(table)
    .where(
      and(
        eq(table.resolver, resolver.toLowerCase() as Hex),
        eq(table.claimUid, claimUid.toLowerCase() as Hex),
        eq((table as any)[actorColumn], actor.toLowerCase() as Hex)
      )
    )
    .orderBy(asc(table.blockNumber), asc(table.logIndex))

  const candidates = rows.filter((r) => !r.revoked && !r.malformed)
  let winner: any = null
  for (const r of candidates) {
    if (
      winner === null ||
      r.blockTimestamp > winner.blockTimestamp ||
      (r.blockTimestamp === winner.blockTimestamp &&
        (r.blockNumber > winner.blockNumber ||
          (r.blockNumber === winner.blockNumber &&
            r.logIndex > winner.logIndex)))
    ) {
      winner = r
    }
  }
  for (const r of rows) {
    const superseded =
      !r.revoked && !r.malformed && winner !== null && r.uid !== winner.uid
    if (r.superseded !== superseded) {
      await context.db.update(table, { uid: r.uid }).set({ superseded })
    }
  }
}

/**
 * One fold-log attestation, from either resolver source (the static summary-configured list or
 * the factory-discovered children — same ABI, same handler; the ponder.config comment explains
 * why they are two sources).
 */
const onContributionAttested = async ({ event, context }: any) => {
    const { eas, uid } = event.args
    const resolver = event.log.address as Hex
    const attestation = await context.client.readContract({
      address: eas,
      abi: easAbi,
      functionName: 'getAttestation',
      args: [uid],
    })

    const schemaIndex = await schemaIndexOf(
      context,
      resolver,
      attestation.schema
    )
    // The resolver reverts unknown schemas, so this cannot happen for a folded attestation; guard
    // anyway rather than corrupt the fold log with a wrong kind.
    if (schemaIndex === null) {
      console.warn(
        `contributions: attestation ${uid} has unknown schema ${attestation.schema}; skipping`
      )
      return
    }

    await context.db.insert(accumulatorRecord).values({
      id: event.id,
      accumulator: resolver,
      kind: schemaIndex * 2, // attest
      attester: attestation.attester,
      recipient: attestation.recipient,
      uid,
      schema: attestation.schema,
      data: attestation.data,
      blockTimestamp: event.block.timestamp,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      txHash: event.transaction.hash,
    })

    if (schemaIndex === 0) {
      // contribution.claim — canonical validity from the guest's structural decoder; display
      // fields from a tolerant ABI decode (both null out for malformed payloads).
      const payload = decodeClaim(attestation.data)
      let title: string | null = null
      let uri: string | null = null
      let contributors: Hex[] | null = null
      let shares: bigint[] | null = null
      try {
        const [t, , u, cs, sh] = decodeAbiParameters(
          CLAIM_PAYLOAD_ABI,
          attestation.data
        )
        title = t
        uri = u
        contributors = cs.map((c: Hex) => c.toLowerCase() as Hex)
        shares = sh.map((x: number) => BigInt(x))
      } catch {
        // display decode failed — keep nulls; `malformed` records the guest's verdict
      }
      await context.db.insert(contributionClaim).values({
        uid,
        resolver,
        attester: attestation.attester,
        recipient: attestation.recipient,
        title,
        contentHash: payload?.contentHash ?? null,
        uri,
        contributors,
        shares,
        malformed: payload === null,
        revoked: false,
        blockTimestamp: event.block.timestamp,
        blockNumber: event.block.number,
        txHash: event.transaction.hash,
      })
      if (payload !== null) {
        // Aggregated per-contributor rows (duplicates summed, like reconciliation).
        const agg = new Map<string, bigint>()
        for (let i = 0; i < payload.contributors.length; i++) {
          const a = payload.contributors[i]!.toLowerCase()
          agg.set(a, (agg.get(a) ?? 0n) + BigInt(payload.shares[i]!))
        }
        for (const [contributor, share] of agg) {
          await context.db
            .insert(contributionClaimContributor)
            .values({
              claimUid: uid,
              contributor: contributor as Hex,
              share,
            })
            .onConflictDoUpdate({ share })
        }
      }
    } else if (schemaIndex === 1) {
      const payload = decodeResponse(attestation.data)
      await context.db.insert(contributionResponse).values({
        uid,
        resolver,
        claimUid: payload?.claimUid ?? null,
        responder: attestation.attester,
        response: payload?.response ?? null,
        malformed: payload === null,
        superseded: false,
        revoked: false,
        blockTimestamp: event.block.timestamp,
        blockNumber: event.block.number,
        logIndex: event.log.logIndex,
        txHash: event.transaction.hash,
      })
      if (payload !== null) {
        await recomputeSuperseded(
          context,
          contributionResponse,
          'responder',
          resolver,
          payload.claimUid,
          attestation.attester
        )
      }
    } else {
      const payload = decodeValuation(attestation.data)
      await context.db.insert(contributionValuation).values({
        uid,
        resolver,
        claimUid: payload?.claimUid ?? null,
        rater: attestation.attester,
        score: payload?.score ?? null,
        malformed: payload === null,
        superseded: false,
        revoked: false,
        blockTimestamp: event.block.timestamp,
        blockNumber: event.block.number,
        logIndex: event.log.logIndex,
        txHash: event.transaction.hash,
      })
      if (payload !== null) {
        await recomputeSuperseded(
          context,
          contributionValuation,
          'rater',
          resolver,
          payload.claimUid,
          attestation.attester
        )
      }
    }
}

/** One fold-log revocation, from either resolver source (see `onContributionAttested`). */
const onContributionRevoked = async ({ event, context }: any) => {
    const { eas, uid } = event.args
    const resolver = event.log.address as Hex
    const attestation = await context.client.readContract({
      address: eas,
      abi: easAbi,
      functionName: 'getAttestation',
      args: [uid],
    })

    const schemaIndex = await schemaIndexOf(
      context,
      resolver,
      attestation.schema
    )
    if (schemaIndex === null) {
      console.warn(
        `contributions: revocation ${uid} has unknown schema ${attestation.schema}; skipping`
      )
      return
    }

    // The revoke fold: same leaf ABI, kind = schemaIndex * 2 + 1, folded at the REVOKE block's
    // timestamp (the data preimage is the original attestation payload).
    await context.db.insert(accumulatorRecord).values({
      id: event.id,
      accumulator: resolver,
      kind: schemaIndex * 2 + 1,
      attester: attestation.attester,
      recipient: attestation.recipient,
      uid,
      schema: attestation.schema,
      data: attestation.data,
      blockTimestamp: event.block.timestamp,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      txHash: event.transaction.hash,
    })

    if (schemaIndex === 0) {
      const existing = await context.db.find(contributionClaim, { uid })
      if (existing) {
        await context.db
          .update(contributionClaim, { uid })
          .set({ revoked: true })
      }
    } else if (schemaIndex === 1) {
      const existing = await context.db.find(contributionResponse, { uid })
      if (existing) {
        await context.db
          .update(contributionResponse, { uid })
          .set({ revoked: true })
        if (existing.claimUid) {
          await recomputeSuperseded(
            context,
            contributionResponse,
            'responder',
            resolver,
            existing.claimUid,
            existing.responder
          )
        }
      }
    } else {
      const existing = await context.db.find(contributionValuation, { uid })
      if (existing) {
        await context.db
          .update(contributionValuation, { uid })
          .set({ revoked: true })
        if (existing.claimUid) {
          await recomputeSuperseded(
            context,
            contributionValuation,
            'rater',
            resolver,
            existing.claimUid,
            existing.rater
          )
        }
      }
    }
}

ponder.on('contributionResolver:AttestationAttested', onContributionAttested)
ponder.on(
  'factoryContributionResolver:AttestationAttested',
  onContributionAttested
)
ponder.on('contributionResolver:AttestationRevoked', onContributionRevoked)
ponder.on(
  'factoryContributionResolver:AttestationRevoked',
  onContributionRevoked
)

/*///////////////////////////////////////////////////////////////
      Derived scoring on MerkleRootUpdated (root-validated)
//////////////////////////////////////////////////////////////*/

/** Read the ordered fold log for one accumulator, truncated to the checkpointed leaf count. */
const loadFoldLog = async (
  context: any,
  accumulator: string,
  count: bigint
) => {
  const rows = await context.db.sql
    .select({
      kind: accumulatorRecord.kind,
      attester: accumulatorRecord.attester,
      recipient: accumulatorRecord.recipient,
      uid: accumulatorRecord.uid,
      data: accumulatorRecord.data,
      blockTimestamp: accumulatorRecord.blockTimestamp,
    })
    .from(accumulatorRecord)
    .where(eq(accumulatorRecord.accumulator, accumulator.toLowerCase() as Hex))
    .orderBy(
      asc(accumulatorRecord.blockNumber),
      asc(accumulatorRecord.logIndex)
    )
    .limit(Number(count))
  return rowsToRawEdges(rows)
}

/** Upsert the round-metadata row (the only row written when verification fails). */
const upsertRound = async (
  row: typeof offchainSchema.contributionRound.$inferInsert
) => {
  await offchainDb
    .insert(offchainSchema.contributionRound)
    .values(row)
    .onConflictDoUpdate({
      target: [
        offchainSchema.contributionRound.merkleSnapshotContract,
        offchainSchema.contributionRound.root,
      ],
      set: Object.fromEntries(
        Object.keys(row)
          .filter((k) => k !== 'merkleSnapshotContract' && k !== 'root')
          .map((k) => {
            const column = (offchainSchema.contributionRound as any)[k]
            return [k, sql.raw(`excluded."${column.name}"`)]
          })
      ),
    })
}

/**
 * Ingest one contributions `MerkleRootUpdated`: rebuild the guest's exact computation from the
 * indexer's own fold-log rows + the controller's hash-selected on-chain tuple, assert every commitment
 * (accumulators, paramsHash, output root, blob), and only then publish `contribution_score` +
 * `contribution_valuation_audit` rows. A mismatch writes `contribution_round.verified = false`
 * and NOTHING else, so the API refuses (409) instead of serving unproven numbers.
 *
 * Called from src/merkle.ts (which fetched + parsed the canonical blob) when the emitting
 * snapshot belongs to a `program: "contributions"` instance.
 */
export async function ingestContributionsScores(
  scores: Record<string, string>,
  event: any,
  context: any,
  root: string,
  ipfsHash: string,
  ipfsHashCid: string,
  totalValue: bigint,
  provenance: ScoreProgramProvenance
): Promise<void> {
  const snapshot = event.log.address as Hex

  const base = {
    merkleSnapshotContract: snapshot.toLowerCase(),
    root,
    ipfsHash,
    ipfsHashCid,
    totalValue,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    programId: provenance.programId,
    outputDomain: provenance.outputDomain,
    programProvenance: provenance,
  }

  const refuse = async (
    reason: string,
    partial: Partial<typeof offchainSchema.contributionRound.$inferInsert> = {}
  ) => {
    console.warn(`contributions: NOT publishing scores for ${root}: ${reason}`)
    await upsertRound({
      ...base,
      checkpointId: '',
      trustAcc: '',
      trustLeafCount: 0n,
      anchorAcc: '',
      anchorCount: 0n,
      paramsHash: '',
      params: null,
      roundStart: null,
      roundEnd: null,
      totalPool: null,
      numClaims: 0,
      numRecipients: 0,
      verified: false,
      failureReason: reason,
      ...partial,
    })
  }

  // 0. The round's input contracts, from the `contributions_instance` row the factory's creation
  //    event materialized (src/contributions-factory.ts) — the DB replacement for the retired
  //    build-time CONTRIBUTIONS_INSTANCES import. Refusing (an unverified round row) rather than
  //    throwing keeps a mis-set-up chain from wedging the indexer.
  const instances = await context.db.sql
    .select({
      trustAccumulator: contributionsInstance.trustAccumulator,
      resolver: contributionsInstance.resolver,
    })
    .from(contributionsInstance)
    .where(eq(contributionsInstance.snapshot, snapshot.toLowerCase() as Hex))
    .limit(1)
  const instance = instances[0]
  if (!instance) {
    await refuse(
      'authenticated snapshot has no contributions_instance row (was this round created through ContributionsFactory?)'
    )
    return
  }

  // 1. The checkpoint this proof consumed, from the submitProof calldata of the same tx.
  let checkpointId: bigint
  try {
    const decoded = decodeFunctionData({
      abi: merkleSnapshotAbi,
      data: event.transaction.input as Hex,
    })
    if (decoded.functionName !== 'submitProof') {
      await refuse('root was not written through submitProof calldata')
      return
    }
    checkpointId = (decoded.args as unknown as [bigint])[0]
  } catch (e) {
    await refuse(`could not decode submitProof calldata: ${e}`)
    return
  }

  // 2. The chain-pinned commitments: slot A (trust, via the mirror), slot B (contributions),
  //    and the governance-pinned paramsHash.
  let trustAcc: Hex
  let trustLeafCount: bigint
  let anchorAcc: Hex
  let anchorCount: bigint
  let chainParamsHash: Hex
  try {
    const mirror = (await context.client.readContract({
      address: snapshot,
      abi: merkleSnapshotAbi,
      functionName: 'accumulator',
    })) as Hex
    const checkpoint = (await context.client.readContract({
      address: mirror,
      abi: trustAccumulatorMirrorAbi,
      functionName: 'getCheckpoint',
      args: [checkpointId],
    })) as { acc: Hex; leafCount: bigint; blockNumber: bigint }
    const ac = (await context.client.readContract({
      address: snapshot,
      abi: merkleSnapshotAbi,
      functionName: 'anchorCheckpoints',
      args: [checkpointId],
    })) as readonly [Hex, bigint]
    chainParamsHash = (await context.client.readContract({
      address: snapshot,
      abi: merkleSnapshotAbi,
      functionName: 'checkpointParamsHash',
      args: [checkpointId],
    })) as Hex
    trustAcc = checkpoint.acc
    trustLeafCount = BigInt(checkpoint.leafCount)
    anchorAcc = ac[0]
    anchorCount = BigInt(ac[1])
  } catch (e) {
    await refuse(`could not read checkpoint state: ${e}`, {
      checkpointId: checkpointId.toString(),
    })
    return
  }

  const committed = {
    checkpointId: checkpointId.toString(),
    trustAcc,
    trustLeafCount,
    anchorAcc,
    anchorCount,
    paramsHash: chainParamsHash,
  }

  // 3. Full tuple selected from append-only controller history by the CHECKPOINT'S pinned hash.
  // Reading the current snapshot hash here would be wrong after a round rotates but an older
  // checkpoint is still being submitted.
  const versions = await context.db.sql
    .select()
    .from(contributionsParameterVersion)
    .where(
      and(
        eq(
          contributionsParameterVersion.snapshot,
          snapshot.toLowerCase() as Hex
        ),
        eq(contributionsParameterVersion.paramsHash, chainParamsHash),
        eq(contributionsParameterVersion.valid, true)
      )
    )
    .orderBy(desc(contributionsParameterVersion.version))
    .limit(1)
  const version = versions[0]
  if (!version) {
    await refuse(
      'no valid on-chain ContributionsParamsUpdated tuple matches the checkpoint paramsHash',
      committed
    )
    return
  }
  let params
  try {
    params = parseParamsSnapshot(version.params as Record<string, unknown>)
  } catch (e) {
    await refuse(
      `on-chain params tuple malformed after indexing: ${e}`,
      committed
    )
    return
  }
  if (
    contributionsParamsHash(params).toLowerCase() !==
    chainParamsHash.toLowerCase()
  ) {
    await refuse(
      'indexed on-chain tuple does not reproduce the checkpoint paramsHash',
      committed
    )
    return
  }

  // 4. The two input streams, from the indexer's own fold log, truncated to the checkpoint.
  const trustEdges = await loadFoldLog(
    context,
    instance.trustAccumulator,
    trustLeafCount
  )
  const records = await loadFoldLog(context, instance.resolver, anchorCount)
  if (
    BigInt(trustEdges.length) !== trustLeafCount ||
    BigInt(records.length) !== anchorCount
  ) {
    await refuse(
      `fold log incomplete (trust ${trustEdges.length}/${trustLeafCount}, records ${records.length}/${anchorCount})`,
      committed
    )
    return
  }
  const trustFold = accumulate(trustEdges)
  const recordFold = accumulate(records)
  if (
    trustFold.acc.toLowerCase() !== trustAcc.toLowerCase() ||
    recordFold.acc.toLowerCase() !== anchorAcc.toLowerCase()
  ) {
    await refuse(
      'refolded accumulator does not match the checkpoint',
      committed
    )
    return
  }

  // 5. The full guest recompute, then assert every journal commitment.
  const result = computeContributions({ trustEdges, records, params })
  if (result.journal.outputRoot.toLowerCase() !== root.toLowerCase()) {
    await refuse(
      `recomputed root ${result.journal.outputRoot} != on-chain root ${root}`,
      committed
    )
    return
  }
  if (result.journal.ipfsHash.toLowerCase() !== ipfsHash.toLowerCase()) {
    await refuse('recomputed blob digest != on-chain ipfsHash', committed)
    return
  }
  // The pinned blob must be the recomputed allocation exactly (guards a gateway serving a
  // different-but-plausible file for the CID).
  const fetched = Object.entries(scores)
  const recomputed = result.scores
  const blobMatches =
    fetched.length === recomputed.length &&
    recomputed.every(
      ([a, v], i) =>
        fetched[i] !== undefined &&
        fetched[i][0].toLowerCase() === a.toLowerCase() &&
        BigInt(fetched[i][1]) === v
    )
  if (!blobMatches) {
    await refuse(
      'fetched IPFS blob does not match the recomputed allocation',
      committed
    )
    return
  }

  // 6. Verified — publish round metadata, per-claim scores + breakdowns, and the audit rows.
  await upsertRound({
    ...base,
    ...committed,
    params: paramsSnapshot(params),
    roundStart: params.roundStart,
    roundEnd: params.roundEnd,
    totalPool: params.totalPool,
    numClaims: result.liveState.claims.size,
    numRecipients: result.scores.length,
    verified: true,
    failureReason: null,
  })

  const scoreRows = deriveScores(result, params)
  if (scoreRows.length > 0) {
    await offchainDb
      .insert(offchainSchema.contributionScore)
      .values(
        scoreRows.map((r) => ({
          merkleSnapshotContract: snapshot.toLowerCase(),
          root,
          claimUid: r.claimUid,
          scoreFp: r.scoreFp,
          contributors: r.contributors,
          blockNumber: event.block.number,
          timestamp: event.block.timestamp,
          programId: provenance.programId,
          outputDomain: SCORE_OUTPUT_DOMAIN_IDS['contributions-claim-v1'],
        }))
      )
      .onConflictDoUpdate({
        target: [
          offchainSchema.contributionScore.merkleSnapshotContract,
          offchainSchema.contributionScore.root,
          offchainSchema.contributionScore.claimUid,
        ],
        set: {
          scoreFp: sql.raw(
            `excluded."${offchainSchema.contributionScore.scoreFp.name}"`
          ),
          contributors: sql.raw(
            `excluded."${offchainSchema.contributionScore.contributors.name}"`
          ),
          blockNumber: sql.raw(
            `excluded."${offchainSchema.contributionScore.blockNumber.name}"`
          ),
          timestamp: sql.raw(
            `excluded."${offchainSchema.contributionScore.timestamp.name}"`
          ),
          programId: sql.raw(
            `excluded."${offchainSchema.contributionScore.programId.name}"`
          ),
          outputDomain: sql.raw(
            `excluded."${offchainSchema.contributionScore.outputDomain.name}"`
          ),
        },
      })
  }

  const auditRows = applyDiscountStatus(deriveAudit(result), params)
  if (auditRows.length > 0) {
    await offchainDb
      .insert(offchainSchema.contributionValuationAudit)
      .values(
        auditRows.map((r) => ({
          merkleSnapshotContract: snapshot.toLowerCase(),
          root,
          claimUid: r.claimUid,
          rater: r.rater,
          score: r.score,
          status: r.status,
          reason: r.reason,
          discountFp: r.discountFp,
          raterRepFp: r.raterRepFp,
          updatedAt: event.block.timestamp,
          programId: provenance.programId,
          outputDomain: SCORE_OUTPUT_DOMAIN_IDS['contributions-claim-v1'],
        }))
      )
      .onConflictDoUpdate({
        target: [
          offchainSchema.contributionValuationAudit.merkleSnapshotContract,
          offchainSchema.contributionValuationAudit.root,
          offchainSchema.contributionValuationAudit.claimUid,
          offchainSchema.contributionValuationAudit.rater,
        ],
        set: {
          score: sql.raw(
            `excluded."${offchainSchema.contributionValuationAudit.score.name}"`
          ),
          status: sql.raw(
            `excluded."${offchainSchema.contributionValuationAudit.status.name}"`
          ),
          reason: sql.raw(
            `excluded."${offchainSchema.contributionValuationAudit.reason.name}"`
          ),
          discountFp: sql.raw(
            `excluded."${offchainSchema.contributionValuationAudit.discountFp.name}"`
          ),
          raterRepFp: sql.raw(
            `excluded."${offchainSchema.contributionValuationAudit.raterRepFp.name}"`
          ),
          updatedAt: sql.raw(
            `excluded."${offchainSchema.contributionValuationAudit.updatedAt.name}"`
          ),
          programId: sql.raw(
            `excluded."${offchainSchema.contributionValuationAudit.programId.name}"`
          ),
          outputDomain: sql.raw(
            `excluded."${offchainSchema.contributionValuationAudit.outputDomain.name}"`
          ),
        },
      })
  }

  console.log(
    `contributions: verified + published root ${root} (${scoreRows.length} claims, ${result.scores.length} recipients, ${auditRows.length} audit rows)`
  )
}
