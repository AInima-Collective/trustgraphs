import {
  Offchain,
  OffchainAttestationVersion,
} from '@ethereum-attestation-service/eas-sdk'
import { getAddress, type Address, type Hex } from 'viem'

import {
  bytesToHex,
  concatBytes,
  equalBytes,
  hexToBytes,
  uintBe,
  utf8,
  ZERO32,
} from './bytes.ts'
import { fail } from './errors.ts'
import type { CanonicalAttestation, LogEntry, PayloadV1 } from './types.ts'

export const PAYLOAD_MAGIC = utf8('TGEAS0PL')
export const PAYLOAD_VERSION = 1
export const MAX_PAYLOAD_BYTES = 1_048_576
export const MAX_ENTRIES_PER_NODE = 2_048
export const MAX_COMMENT_BYTES = 4_096
export const MIN_DATA_BYTES = 96
export const MAX_DATA_BYTES = 4_192
export const E0_ENTRY_WORK_UNITS = 4n

const SECP256K1_HALF_N = BigInt(
  '0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0'
)
const SECP256K1_N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
)

class Decoder {
  offset = 0

  constructor(readonly bytes: Uint8Array) {}

  take(length: number): Uint8Array {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.offset + length > this.bytes.length
    )
      return fail('E0_TRUNCATED', 'payload is truncated')
    const value = this.bytes.slice(this.offset, this.offset + length)
    this.offset += length
    return value
  }

  uint(width: number): bigint {
    let value = 0n
    for (const byte of this.take(width)) value = (value << 8n) | BigInt(byte)
    return value
  }

  hex(length: number): Hex {
    return bytesToHex(this.take(length))
  }
}

const expectLength = (value: Hex, bytes: number, label: string): void => {
  if (hexToBytes(value).length !== bytes)
    fail('E0_CANONICAL', `${label} must be ${bytes} bytes`)
}

export const assertCanonicalSignature = (signature: Hex): void => {
  const value = hexToBytes(signature)
  if (value.length !== 65 || (value[64] !== 27 && value[64] !== 28))
    fail('E0_SIGNATURE_FORM', 'signature must be r,s,v with v 27 or 28')
  const r = BigInt(bytesToHex(value.slice(0, 32)))
  const s = BigInt(bytesToHex(value.slice(32, 64)))
  if (r === 0n || r >= SECP256K1_N || s === 0n || s > SECP256K1_HALF_N)
    fail('E0_SIGNATURE_FORM', 'signature must use canonical low-s form')
}

export const assertCanonicalProfileData = (data: Hex): void => {
  const value = hexToBytes(data)
  if (value.length < MIN_DATA_BYTES || value.length > MAX_DATA_BYTES)
    fail('E0_DATA_LIMIT', 'profile data is outside the bounded size')
  if (value.length % 32 !== 0)
    fail('E0_DATA_ABI', 'profile data length is not ABI aligned')
  if (value.slice(0, 31).some(Boolean) || value[31] !== 64)
    fail('E0_DATA_ABI', 'profile data has a non-canonical string offset')
  const commentLength = Number(BigInt(bytesToHex(value.slice(64, 96))))
  if (!Number.isSafeInteger(commentLength) || commentLength > MAX_COMMENT_BYTES)
    fail('E0_DATA_LIMIT', 'profile comment exceeds 4096 bytes')
  const expectedLength = MIN_DATA_BYTES + Math.ceil(commentLength / 32) * 32
  if (value.length !== expectedLength)
    fail('E0_DATA_ABI', 'profile data has a non-canonical dynamic length')
  if (value.slice(MIN_DATA_BYTES + commentLength).some(Boolean))
    fail('E0_DATA_ABI', 'profile data has nonzero ABI padding')
}

export const attestationUid = (
  attestation: Omit<CanonicalAttestation, 'uid' | 'signature'>
): Hex =>
  Offchain.getOffchainUID(
    OffchainAttestationVersion.Version2,
    attestation.schema,
    attestation.recipient,
    attestation.time,
    attestation.expirationTime,
    attestation.revocable,
    attestation.refUID,
    attestation.data,
    attestation.salt
  ) as Hex

const validateAttestation = (
  attestation: CanonicalAttestation,
  expectedSchema: Hex
): void => {
  if (attestation.version !== 2)
    fail('E0_PROFILE_VERSION', 'only EAS offchain v2 is accepted')
  if (attestation.schema.toLowerCase() !== expectedSchema.toLowerCase())
    fail('E0_SCHEMA', 'attestation schema does not match the lane')
  if (
    getAddress(attestation.recipient) ===
    '0x0000000000000000000000000000000000000000'
  )
    fail('E0_RECIPIENT', 'recipient must be nonzero')
  if (attestation.expirationTime !== 0n)
    fail('E0_EXPIRATION', 'expirationTime must be zero')
  if (!attestation.revocable)
    fail('E0_REVOCABLE', 'attestation must be revocable')
  if (attestation.refUID !== ZERO32) fail('E0_REF_UID', 'refUID must be zero')
  if (attestation.salt === ZERO32) fail('E0_ZERO_SALT', 'salt must be nonzero')
  expectLength(attestation.schema, 32, 'schema')
  expectLength(attestation.salt, 32, 'salt')
  assertCanonicalProfileData(attestation.data)
  assertCanonicalSignature(attestation.signature)
  if (attestationUid(attestation) !== attestation.uid)
    fail('E0_UID', 'attestation UID does not match its signed fields')
}

export const validatePayload = (
  payload: PayloadV1,
  expectedSchema: Hex
): void => {
  if (
    payload.entries.length === 0 ||
    payload.entries.length > MAX_ENTRIES_PER_NODE
  )
    fail('E0_ENTRY_LIMIT', 'entry count is outside the strict lane bound')
  if (payload.attestations.length > payload.entries.length)
    fail('E0_COUNT_MISMATCH', 'more attestations than log entries')
  const seen = new Set<string>()
  const live = new Set<string>()
  let attestationIndex = 0
  for (const entry of payload.entries) {
    expectLength(entry.uid, 32, 'entry UID')
    if (entry.kind === 0) {
      const attestation =
        payload.attestations[attestationIndex++] ??
        fail('E0_COUNT_MISMATCH', 'attest entry has no attestation body')
      validateAttestation(attestation, expectedSchema)
      if (seen.has(entry.uid))
        fail('E0_DUPLICATE_ATTEST', 'attestation UID is duplicated')
      if (entry.uid !== attestation.uid)
        fail('E0_UID', 'entry UID does not match attestation body')
      seen.add(entry.uid)
      live.add(entry.uid)
    } else if (entry.kind === 1) {
      if (!seen.has(entry.uid))
        fail('E0_REVOKE_BEFORE_ATTEST', 'revocation precedes attestation')
      if (!live.delete(entry.uid))
        fail('E0_ALREADY_REVOKED', 'attestation is already revoked')
    } else {
      fail('E0_LOG_KIND', 'unsupported log entry kind')
    }
  }
  if (attestationIndex !== payload.attestations.length)
    fail(
      'E0_COUNT_MISMATCH',
      'attestation body count does not match attest entries'
    )
}

/**
 * Reject a payload that cannot be proven against an anchor at `maximumTimestamp`.
 *
 * Historical reconstruction applies this rule at each entry's first committing anchor. A relay
 * only knows the timestamp of the latest finalized block before it submits, so it uses this as a
 * conservative preflight and asks the client to retry after chain time catches up.
 */
export const assertNoFutureAttestations = (
  payload: Pick<PayloadV1, 'attestations'>,
  maximumTimestamp: bigint
): void => {
  for (const attestation of payload.attestations) {
    if (attestation.time > maximumTimestamp)
      fail(
        'E0_FUTURE_TIME',
        'attestation time is after the committing chain timestamp',
        {
          attestationTime: attestation.time.toString(),
          maximumTimestamp: maximumTimestamp.toString(),
        }
      )
  }
}

export const encodePayload = (payload: PayloadV1): Uint8Array => {
  const expectedSchema =
    payload.attestations[0]?.schema ??
    fail('E0_COUNT_MISMATCH', 'payload requires an attestation body')
  validatePayload(payload, expectedSchema)
  const chunks: Uint8Array[] = [
    PAYLOAD_MAGIC,
    uintBe(PAYLOAD_VERSION, 2),
    hexToBytes(payload.owner),
    uintBe(payload.entries.length, 4),
    uintBe(payload.attestations.length, 4),
  ]
  for (const entry of payload.entries)
    chunks.push(uintBe(entry.kind, 1), hexToBytes(entry.uid))
  for (const attestation of payload.attestations) {
    const data = hexToBytes(attestation.data)
    chunks.push(
      uintBe(attestation.version, 2),
      hexToBytes(attestation.schema),
      hexToBytes(attestation.recipient),
      uintBe(attestation.time, 8),
      uintBe(attestation.expirationTime, 8),
      uintBe(1, 1),
      hexToBytes(attestation.refUID),
      uintBe(data.length, 4),
      data,
      hexToBytes(attestation.salt),
      hexToBytes(attestation.signature)
    )
  }
  const encoded = concatBytes(...chunks)
  if (encoded.length > MAX_PAYLOAD_BYTES)
    fail('E0_PAYLOAD_LIMIT', 'payload exceeds 1 MiB')
  return encoded
}

export const decodePayload = (
  bytes: Uint8Array,
  expectedSchema: Hex
): PayloadV1 => {
  if (bytes.length > MAX_PAYLOAD_BYTES)
    fail('E0_PAYLOAD_LIMIT', 'payload exceeds 1 MiB')
  const decoder = new Decoder(bytes)
  if (!equalBytes(decoder.take(PAYLOAD_MAGIC.length), PAYLOAD_MAGIC))
    fail('E0_MAGIC', 'payload magic mismatch')
  if (decoder.uint(2) !== BigInt(PAYLOAD_VERSION))
    fail('E0_PAYLOAD_VERSION', 'payload version mismatch')
  const owner = getAddress(decoder.hex(20))
  const entryCount = Number(decoder.uint(4))
  const attestationCount = Number(decoder.uint(4))
  if (entryCount === 0 || entryCount > MAX_ENTRIES_PER_NODE)
    fail('E0_ENTRY_LIMIT', 'entry count is outside the strict lane bound')
  if (attestationCount > entryCount)
    fail('E0_COUNT_MISMATCH', 'more attestations than log entries')
  const entries: LogEntry[] = []
  for (let i = 0; i < entryCount; i += 1) {
    const kind = Number(decoder.uint(1))
    if (kind !== 0 && kind !== 1)
      fail('E0_LOG_KIND', 'unsupported log entry kind')
    entries.push({ kind: kind as 0 | 1, uid: decoder.hex(32) })
  }
  const attestations: CanonicalAttestation[] = []
  for (let i = 0; i < attestationCount; i += 1) {
    const version = Number(decoder.uint(2))
    if (version !== 2)
      fail('E0_PROFILE_VERSION', 'only EAS offchain v2 is accepted')
    const schema = decoder.hex(32)
    const recipient = getAddress(decoder.hex(20))
    const time = decoder.uint(8)
    const expirationTime = decoder.uint(8)
    const revocable = decoder.uint(1)
    const refUID = decoder.hex(32)
    const dataLength = Number(decoder.uint(4))
    if (dataLength < MIN_DATA_BYTES || dataLength > MAX_DATA_BYTES)
      fail('E0_DATA_LIMIT', 'profile data is outside the bounded size')
    const data = decoder.hex(dataLength)
    const salt = decoder.hex(32)
    const signature = decoder.hex(65)
    const partial = {
      version: 2 as const,
      schema,
      recipient,
      time,
      expirationTime: expirationTime as 0n,
      revocable: (revocable === 1n) as true,
      refUID,
      data,
      salt,
      signature,
    }
    attestations.push({ ...partial, uid: attestationUid(partial) })
  }
  if (decoder.offset !== bytes.length)
    fail('E0_TRAILING_BYTES', 'payload has trailing bytes')
  const payload = { owner, entries, attestations }
  validatePayload(payload, expectedSchema)
  if (!equalBytes(encodePayload(payload), bytes))
    fail('E0_CANONICAL', 'payload encoding is not canonical')
  return payload
}
