import { ponder } from 'ponder:registry'
import {
  easCanonicalAttestation,
  easImportOperation,
  easImportSyncHead,
  easSchemaRecord,
} from 'ponder:schema'

import { canonicalEasAbi } from '../abis/canonicalEas'

const operationId = (importer: string, uid: string, kind: number) =>
  `${importer.toLowerCase()}:${uid.toLowerCase()}:${kind}`

const readAttestation = (event: any, context: any, uid: `0x${string}`) =>
  context.client.readContract({
    address: event.log.address,
    abi: canonicalEasAbi,
    functionName: 'getAttestation',
    args: [uid],
    blockNumber: event.block.number,
  })

ponder.on('easSchemaRegistry:Registered', async ({ event, context }) => {
  const { uid, registerer, schema } = event.args
  await context.db.insert(easSchemaRecord).values({
    uid,
    registry: event.log.address,
    registerer,
    resolver: schema.resolver,
    revocable: schema.revocable,
    schema: schema.schema,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  })
})

ponder.on('canonicalEas:Attested', async ({ event, context }) => {
  const attestation = await readAttestation(event, context, event.args.uid)
  await context.db.insert(easCanonicalAttestation).values({
    uid: attestation.uid,
    eas: event.log.address,
    schema: attestation.schema,
    attester: attestation.attester,
    recipient: attestation.recipient,
    ref: attestation.refUID,
    revocable: attestation.revocable,
    expirationTime: attestation.expirationTime,
    revocationTime: attestation.revocationTime,
    data: attestation.data,
    sourceTime: attestation.time,
    sourceBlock: event.block.number,
    sourceLogIndex: event.log.logIndex,
    sourceTxHash: event.transaction.hash,
  })
})

ponder.on('canonicalEas:Revoked', async ({ event, context }) => {
  const attestation = await readAttestation(event, context, event.args.uid)
  await context.db
    .insert(easCanonicalAttestation)
    .values({
      uid: attestation.uid,
      eas: event.log.address,
      schema: attestation.schema,
      attester: attestation.attester,
      recipient: attestation.recipient,
      ref: attestation.refUID,
      revocable: attestation.revocable,
      expirationTime: attestation.expirationTime,
      revocationTime: attestation.revocationTime,
      data: attestation.data,
      sourceTime: attestation.time,
      // A missing attest row means the configured cursor began mid-history. Keep the record usable
      // but do not pretend this revoke block was its creation watermark.
      sourceBlock: 0n,
      sourceLogIndex: 0,
      sourceTxHash: event.transaction.hash,
      revokedBlock: event.block.number,
      revokedLogIndex: event.log.logIndex,
      revokedTxHash: event.transaction.hash,
    })
    .onConflictDoUpdate({
      revocationTime: attestation.revocationTime,
      revokedBlock: event.block.number,
      revokedLogIndex: event.log.logIndex,
      revokedTxHash: event.transaction.hash,
    })
})

export const recordFoldedImport =
  (kind: 0 | 1 | 2) =>
  async ({ event, context }: any) => {
    await context.db
      .insert(easImportOperation)
      .values({
        id: operationId(event.log.address, event.args.uid, kind),
        importer: event.log.address,
        uid: event.args.uid,
        kind,
        outcome: 'folded',
        sourceTimestamp: event.args.timestamp,
        blockNumber: event.block.number,
        logIndex: event.log.logIndex,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
      })
      .onConflictDoNothing()
  }

ponder.on(
  'onchainAttestationImporter:AttestationImported',
  recordFoldedImport(0)
)
ponder.on(
  'onchainAttestationImporter:RevocationImported',
  recordFoldedImport(1)
)

ponder.on(
  'onchainAttestationImporter:ImportSkipped',
  async ({ event, context }) => {
    // AlreadyProcessed is an idempotent retry, not a new outcome. The original folded/zero row is
    // authoritative. ZeroRecipient is terminal and counts as processed without an accumulator leaf.
    if (Number(event.args.reason) !== 1) return
    const kind = Number(event.args.kind)
    const canonical = await context.db.find(easCanonicalAttestation, {
      uid: event.args.uid,
    })
    const sourceTimestamp = canonical
      ? kind === 0
        ? canonical.sourceTime
        : kind === 1
          ? canonical.revocationTime
          : canonical.expirationTime
      : 0n
    await context.db
      .insert(easImportOperation)
      .values({
        id: operationId(event.log.address, event.args.uid, kind),
        importer: event.log.address,
        uid: event.args.uid,
        kind,
        outcome: 'skipped-zero-recipient',
        sourceTimestamp,
        blockNumber: event.block.number,
        logIndex: event.log.logIndex,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
      })
      .onConflictDoNothing()
  }
)

ponder.on('easImportHead:block', async ({ event, context }) => {
  const id = `${context.chain.id}`
  await context.db
    .insert(easImportSyncHead)
    .values({
      id,
      chainId: `${context.chain.id}`,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
    })
    .onConflictDoUpdate({
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
    })
})
