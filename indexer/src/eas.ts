import { ponder } from 'ponder:registry'
import { accumulatorRecord, easAttestation } from 'ponder:schema'

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
  await context.db.insert(easAttestation).values({
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
    timestamp: event.block.timestamp,
  })

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
    blockTimestamp: event.block.timestamp,
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
  await context.db
    .update(easAttestation, { uid })
    .set({ revocationTime: attestation.revocationTime })

  // The revoke fold (kind 1): same leaf ABI, folded at the revoke block's timestamp, data
  // preimage = the original attestation payload (see accumulatorRecord note above).
  await context.db.insert(accumulatorRecord).values({
    id: event.id,
    accumulator: event.log.address,
    kind: 1,
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

  await revalidateNetwork()
}

ponder.on('easIndexerResolver:AttestationAttested', onAttested)
ponder.on('weightedEasIndexerResolver:AttestationAttested', onAttested)
ponder.on('easIndexerResolver:AttestationRevoked', onRevoked)
ponder.on('weightedEasIndexerResolver:AttestationRevoked', onRevoked)
