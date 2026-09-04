import { ponder } from 'ponder:registry'
import { accumulatorRecord, easAttestation } from 'ponder:schema'

import { easExpirationFoldTimestamp, easFoldTimestamp } from './eas-fold-time'
import { recordFoldedImport } from './eas-import'
import { revalidateNetwork } from './utils'
import { easAbi } from '../../frontend/lib/contract-abis'

const onAttested = async ({ event, context }: any) => {
  const { eas, uid } = event.args
  const attestation = await context.client.readContract({
    address: eas,
    abi: easAbi,
    functionName: 'getAttestation',
    args: [uid],
  })
  const foldTimestamp = easFoldTimestamp(attestation, 'attest')
  // EAS UIDs are globally canonical, while the same historical UID may be imported into several
  // accumulators. Keep one source record here; accumulatorRecord stores every graph membership.
  await context.db
    .insert(easAttestation)
    .values({
      uid,
      schema: attestation.schema,
      resolver: event.log.address,
      attester: attestation.attester,
      recipient: attestation.recipient,
      ref: attestation.refUID,
      revocable: attestation.revocable,
      expirationTime: attestation.expirationTime,
      revocationTime: attestation.revocationTime,
      data: attestation.data,
      blockNumber: event.block.number,
      timestamp: foldTimestamp,
    })
    .onConflictDoNothing()

  // Mirror the resolver's accumulator fold (kind 0 = attest — EASIndexerResolver.onAttest folds
  // exactly one leaf per Attested marker). Ordering by (blockNumber, logIndex) is fold order;
  // the contributions program's derived scoring refolds this log and asserts the checkpointed
  // accumulator before trusting it (src/contributions.ts).
  await context.db.insert(accumulatorRecord).values({
    id: event.id,
    accumulator: event.log.address,
    kind: 0,
    attester: attestation.attester,
    recipient: attestation.recipient,
    uid,
    schema: attestation.schema,
    data: attestation.data,
    blockTimestamp: foldTimestamp,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    txHash: event.transaction.hash,
  })

  await revalidateNetwork()
}

const onRevoked = async ({ event, context }: any) => {
  const { eas, uid } = event.args
  const attestation = await context.client.readContract({
    address: eas,
    abi: easAbi,
    functionName: 'getAttestation',
    args: [uid],
  })
  const foldTimestamp = easFoldTimestamp(attestation, 'revoke')
  // Out-of-universe guard: ensure-by-readback. The full attestation was just read from the EAS
  // contract, so a revocation whose attest marker predates the start block (or was folded by a
  // resolver we began watching mid-life) materializes the complete row instead of wedging on a
  // bare update. The revoke-fold accumulator record below needs the same data either way.
  await context.db
    .insert(easAttestation)
    .values({
      uid,
      schema: attestation.schema,
      resolver: event.log.address,
      attester: attestation.attester,
      recipient: attestation.recipient,
      ref: attestation.refUID,
      revocable: attestation.revocable,
      expirationTime: attestation.expirationTime,
      revocationTime: attestation.revocationTime,
      data: attestation.data,
      blockNumber: event.block.number,
      timestamp: easFoldTimestamp(attestation, 'attest'),
    })
    .onConflictDoUpdate({ revocationTime: attestation.revocationTime })

  // The revoke fold (kind 1): same leaf ABI, folded at EAS's authenticated revocationTime, data
  // preimage = the original attestation payload (see accumulatorRecord note above). For native
  // resolver calls this equals the event block timestamp; delayed imports must retain history.
  await context.db.insert(accumulatorRecord).values({
    id: event.id,
    accumulator: event.log.address,
    kind: 1,
    attester: attestation.attester,
    recipient: attestation.recipient,
    uid,
    schema: attestation.schema,
    data: attestation.data,
    blockTimestamp: foldTimestamp,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    txHash: event.transaction.hash,
  })

  await revalidateNetwork()
}

const onExpired = async ({ event, context }: any) => {
  const { eas, uid, timestamp } = event.args
  const attestation = await context.client.readContract({
    address: eas,
    abi: easAbi,
    functionName: 'getAttestation',
    args: [uid],
  })
  const foldTimestamp = easExpirationFoldTimestamp(attestation, timestamp)

  // The UID row is canonical EAS data and may already have been observed through another importer.
  // Per-accumulator membership lives below in accumulatorRecord, whose event id is instance-local.
  await context.db
    .insert(easAttestation)
    .values({
      uid,
      schema: attestation.schema,
      resolver: event.log.address,
      attester: attestation.attester,
      recipient: attestation.recipient,
      ref: attestation.refUID,
      revocable: attestation.revocable,
      expirationTime: attestation.expirationTime,
      revocationTime: attestation.revocationTime,
      data: attestation.data,
      blockNumber: event.block.number,
      timestamp: easFoldTimestamp(attestation, 'attest'),
    })
    .onConflictDoNothing()

  await context.db.insert(accumulatorRecord).values({
    id: event.id,
    accumulator: event.log.address,
    kind: 1,
    attester: attestation.attester,
    recipient: attestation.recipient,
    uid,
    schema: attestation.schema,
    data: attestation.data,
    blockTimestamp: foldTimestamp,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    txHash: event.transaction.hash,
  })

  // Ponder permits one indexing function per source event. Record sync progress here alongside
  // the accumulator fold so ExpirationImported remains one atomic handler.
  await recordFoldedImport(2)({ event, context })

  await revalidateNetwork()
}

ponder.on('easIndexerResolver:AttestationAttested', onAttested)
ponder.on('weightedEasIndexerResolver:AttestationAttested', onAttested)
ponder.on('easIndexerResolver:AttestationRevoked', onRevoked)
ponder.on('weightedEasIndexerResolver:AttestationRevoked', onRevoked)
ponder.on('onchainAttestationImporter:AttestationAttested', onAttested)
ponder.on('onchainAttestationImporter:AttestationRevoked', onRevoked)
ponder.on('onchainAttestationImporter:ExpirationImported', onExpired)
