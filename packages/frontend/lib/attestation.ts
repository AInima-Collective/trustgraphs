import { Hex } from 'viem'

import { easAttestation } from '@/ponder.schema'

import type { AttestationProvenance } from './attestation-provenance'
import { SchemaManager } from './schemas'
import { formatTimeAgo } from './utils'

export enum AttestationStatus {
  VERIFIED = 'verified',
  EXPIRED = 'expired',
  REVOKED = 'revoked',
}

export type AttestationApiRow = typeof easAttestation.$inferSelect & {
  /** Present on hybrid network responses; absent on plain onchain-only rows. */
  provenance?: AttestationProvenance
}

export interface AttestationData {
  uid: Hex
  schema: Hex
  schemaName: string
  attester: Hex
  recipient: Hex
  ref: Hex
  time: bigint
  formattedTime: string
  formattedTimeAgo: string
  revocable: boolean
  expirationTime: bigint
  revocationTime: bigint
  data: Hex
  decodedData: Record<string, any>
  status: `${AttestationStatus}`
  provenance?: AttestationProvenance
}

/**
 * Convert Ponder attestation table data to AttestationData.
 */
export function intoAttestationData(): null
export function intoAttestationData(ponderData: undefined): null
export function intoAttestationData(ponderData: null): null
export function intoAttestationData(
  ponderData: AttestationApiRow
): AttestationData
export function intoAttestationData(
  ponderData: AttestationApiRow | undefined
): AttestationData
// The shape a guarded ponder query hands to `select`: a missing row is `null`, never `undefined`.
// Without this overload TS resolves the call to the one above and then rejects it, because that
// one promises an `AttestationData` for an input this function answers `null` to.
export function intoAttestationData(
  ponderData: AttestationApiRow | null
): AttestationData | null
export function intoAttestationData(
  ponderData?: AttestationApiRow | null
): AttestationData | null {
  if (!ponderData) {
    return null
  }

  const schemaName =
    SchemaManager.maybeSchemaForUid(ponderData.schema)?.name || 'Unknown'

  const status =
    ponderData.revocationTime > 0
      ? AttestationStatus.REVOKED
      : ponderData.expirationTime > 0 &&
          ponderData.expirationTime < Math.floor(Date.now() / 1000)
        ? AttestationStatus.EXPIRED
        : AttestationStatus.VERIFIED

  // Decode the attestation data using SchemaManager
  let decodedData
  try {
    decodedData = SchemaManager.decode(ponderData.schema, ponderData.data)
  } catch (error) {
    console.error('Error decoding attestation data', ponderData, error)
    decodedData = {}
  }

  const date = new Date(Number(ponderData.timestamp) * 1000)
  const formattedTime =
    ponderData.timestamp <= 0n || isNaN(Number(ponderData.timestamp))
      ? '<invalid timestamp>'
      : isNaN(date.getTime())
        ? '<invalid date>'
        : date.toISOString().replace('T', ' ').split('.')[0]

  return {
    uid: ponderData.uid,
    schema: ponderData.schema,
    schemaName,
    attester: ponderData.attester,
    recipient: ponderData.recipient,
    time: ponderData.timestamp,
    formattedTime,
    formattedTimeAgo: formattedTime.includes('invalid')
      ? '<invalid>'
      : formatTimeAgo(Number(ponderData.timestamp) * 1000),
    ref:
      ponderData.ref ||
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    revocable: ponderData.revocable || false,
    expirationTime: ponderData.expirationTime,
    revocationTime: ponderData.revocationTime,
    data: ponderData.data,
    decodedData,
    status,
    ...(ponderData.provenance ? { provenance: ponderData.provenance } : {}),
  }
}

export const intoAttestationsData = (
  ponderData: AttestationApiRow[]
): AttestationData[] =>
  // Called through an arrow rather than passed to `.map` directly: every element here is a real
  // row, so this must pick the non-null overload, and point-free `.map(intoAttestationData)`
  // resolves against the whole overload set and drags `| null` into the result type.
  ponderData.map((row) => intoAttestationData(row))
