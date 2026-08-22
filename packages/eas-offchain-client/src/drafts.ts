import type { Hex } from 'viem'

import { base64Decode, base64Encode, utf8, ZERO32 } from './bytes.ts'
import {
  addressNodeId,
  payloadCommitment,
  prefixHeads,
  rawCid,
} from './bundle.ts'
import { decodePayload } from './codec.ts'
import { fail } from './errors.ts'
import type {
  DraftOperation,
  EncryptedDraft,
  LiveNodeHead,
  PayloadV1,
  RecoverableDraft,
  SignedAnchorBundle,
} from './types.ts'

const ITERATIONS = 310_000

const draftJson = (draft: RecoverableDraft): string =>
  JSON.stringify(draft, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  )

export const encryptDraft = async (
  draft: RecoverableDraft,
  passphrase: string
): Promise<EncryptedDraft> => {
  if (passphrase.length < 12)
    fail('E0_DRAFT_CRYPTO', 'draft passphrase must be at least 12 characters')
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const material = await globalThis.crypto.subtle.importKey(
    'raw',
    utf8(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  const key = await globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  )
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    utf8(draftJson(draft))
  )
  return {
    protocol: 'TrustgraphsEncryptedDraftV1',
    kdf: 'PBKDF2-SHA256',
    iterations: ITERATIONS,
    salt: base64Encode(salt),
    cipher: 'AES-256-GCM',
    iv: base64Encode(iv),
    ciphertext: base64Encode(new Uint8Array(ciphertext)),
  }
}

export const decryptDraft = async (
  encrypted: EncryptedDraft,
  passphrase: string
): Promise<RecoverableDraft> => {
  try {
    if (
      encrypted.protocol !== 'TrustgraphsEncryptedDraftV1' ||
      encrypted.kdf !== 'PBKDF2-SHA256' ||
      encrypted.cipher !== 'AES-256-GCM' ||
      encrypted.iterations < ITERATIONS
    )
      return fail(
        'E0_DRAFT_CRYPTO',
        'unsupported or weakened encrypted draft format'
      )
    const material = await globalThis.crypto.subtle.importKey(
      'raw',
      utf8(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    )
    const key = await globalThis.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: base64Decode(encrypted.salt),
        iterations: encrypted.iterations,
        hash: 'SHA-256',
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    )
    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64Decode(encrypted.iv) },
      key,
      base64Decode(encrypted.ciphertext)
    )
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Omit<
      RecoverableDraft,
      'base' | 'operations'
    > & {
      base: Omit<LiveNodeHead, 'count'> & { count: string }
      operations: Array<
        | {
            kind: 'attest'
            attestation: Omit<
              Extract<DraftOperation, { kind: 'attest' }>['attestation'],
              'time' | 'expirationTime'
            > & { time: string; expirationTime: string }
          }
        | Extract<DraftOperation, { kind: 'revoke' }>
      >
    }
    return {
      ...parsed,
      base: { ...parsed.base, count: BigInt(parsed.base.count) },
      operations: parsed.operations.map((operation) =>
        operation.kind === 'attest'
          ? {
              ...operation,
              attestation: {
                ...operation.attestation,
                time: BigInt(operation.attestation.time),
                expirationTime: BigInt(
                  operation.attestation.expirationTime
                ) as 0n,
              },
            }
          : operation
      ),
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'EasOffchainError') throw error
    return fail('E0_DRAFT_CRYPTO', 'draft authentication or decryption failed')
  }
}

export const applyOperations = (
  canonical: PayloadV1 | undefined,
  owner: PayloadV1['owner'],
  operations: readonly DraftOperation[]
): PayloadV1 => {
  const payload: PayloadV1 = canonical
    ? {
        owner: canonical.owner,
        entries: canonical.entries.map((entry) => ({ ...entry })),
        attestations: canonical.attestations.map((attestation) => ({
          ...attestation,
        })),
      }
    : { owner, entries: [], attestations: [] }
  if (payload.owner.toLowerCase() !== owner.toLowerCase())
    fail('E0_NODE_ID', 'canonical payload belongs to another owner')
  const seen = new Set(
    payload.entries
      .filter((entry) => entry.kind === 0)
      .map((entry) => entry.uid)
  )
  const live = new Set(seen)
  for (const entry of payload.entries)
    if (entry.kind === 1) live.delete(entry.uid)
  for (const operation of operations) {
    if (operation.kind === 'attest') {
      if (seen.has(operation.attestation.uid))
        fail(
          'E0_DUPLICATE_ATTEST',
          'draft attestation already exists in canonical history'
        )
      payload.entries.push({ kind: 0, uid: operation.attestation.uid })
      payload.attestations.push(operation.attestation)
      seen.add(operation.attestation.uid)
      live.add(operation.attestation.uid)
    } else {
      if (!seen.has(operation.uid))
        fail(
          'E0_REVOKE_BEFORE_ATTEST',
          'draft revocation target is absent after reload'
        )
      if (!live.delete(operation.uid))
        fail(
          'E0_ALREADY_REVOKED',
          'draft revocation target is already revoked after reload'
        )
      payload.entries.push({ kind: 1, uid: operation.uid })
    }
  }
  return payload
}

export type SubmissionResolution =
  | { kind: 'success'; bundle: SignedAnchorBundle }
  | {
      kind: 'reload'
      live: LiveNodeHead
      reason: 'advanced' | 'same-count-fork'
    }

export const resolveSubmission = (
  bundle: SignedAnchorBundle,
  live: LiveNodeHead
): SubmissionResolution => {
  const requestedCount = BigInt(bundle.message.count)
  if (
    live.count === requestedCount &&
    live.head === bundle.message.head &&
    live.dataCommitment === bundle.dataCommitment
  )
    return { kind: 'success', bundle }
  if (live.count === requestedCount)
    return { kind: 'reload', live, reason: 'same-count-fork' }
  return { kind: 'reload', live, reason: 'advanced' }
}

export const assertSyncedBeforeEdit = (
  draft: RecoverableDraft,
  live: LiveNodeHead
): void => {
  if (
    draft.base.count !== live.count ||
    draft.base.head !== live.head ||
    draft.base.dataCommitment !== live.dataCommitment
  )
    fail(
      'E0_CONFLICT',
      'draft base is stale; reload canonical payload and reapply operations',
      {
        liveCount: live.count.toString(),
        liveHead: live.head,
        liveDataCommitment: live.dataCommitment,
      }
    )
}

export const uidOfOperation = (operation: DraftOperation): Hex =>
  operation.kind === 'attest' ? operation.attestation.uid : operation.uid

export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const saveEncryptedDraft = async (
  storage: DraftStorage,
  key: string,
  draft: RecoverableDraft,
  passphrase: string
): Promise<void> => {
  storage.setItem(key, JSON.stringify(await encryptDraft(draft, passphrase)))
}

export const loadEncryptedDraft = async (
  storage: DraftStorage,
  key: string,
  passphrase: string
): Promise<RecoverableDraft | undefined> => {
  const value = storage.getItem(key)
  if (value === null) return undefined
  try {
    return decryptDraft(JSON.parse(value) as EncryptedDraft, passphrase)
  } catch (error) {
    if (error instanceof Error && error.name === 'EasOffchainError') throw error
    return fail('E0_DRAFT_CRYPTO', 'stored draft format is invalid')
  }
}

export interface CanonicalNodeSource {
  readLive(nodeId: Hex): Promise<LiveNodeHead>
  readPayload(cid: string): Promise<Uint8Array>
}

export type SyncedNode = {
  live: LiveNodeHead
  payload?: PayloadV1
  cid?: string
}

export const syncCanonicalNode = async (args: {
  source: CanonicalNodeSource
  owner: PayloadV1['owner']
  schemaUid: Hex
}): Promise<SyncedNode> => {
  const live = await args.source.readLive(addressNodeId(args.owner))
  if (live.count === 0n) {
    if (live.head !== ZERO32 || live.dataCommitment !== ZERO32)
      fail('E0_CONFLICT', 'unregistered node has nonzero canonical state')
    return { live }
  }
  const cid = rawCid(live.dataCommitment)
  const bytes = await args.source.readPayload(cid)
  if (payloadCommitment(bytes) !== live.dataCommitment)
    fail(
      'E0_COMMITMENT',
      'canonical payload bytes do not match live commitment'
    )
  const payload = decodePayload(bytes, args.schemaUid)
  if (payload.owner.toLowerCase() !== args.owner.toLowerCase())
    fail('E0_NODE_ID', 'canonical payload owner does not match requested node')
  const heads = prefixHeads(payload)
  if (
    BigInt(payload.entries.length) !== live.count ||
    heads.at(-1) !== live.head
  )
    fail('E0_HEAD', 'canonical payload does not match live count and head')
  return { live, payload, cid }
}

export const reloadAndReapply = async (
  draft: RecoverableDraft,
  source: CanonicalNodeSource
): Promise<{ sync: SyncedNode; payload: PayloadV1 }> => {
  const sync = await syncCanonicalNode({
    source,
    owner: draft.owner,
    schemaUid: draft.schemaUid,
  })
  return {
    sync,
    payload: applyOperations(sync.payload, draft.owner, draft.operations),
  }
}
