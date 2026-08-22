import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

import { SchemaEncoder } from '@ethereum-attestation-service/eas-sdk'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'

import {
  applyOperations,
  assertSyncedBeforeEdit,
  bytesToHex,
  createSignedBundle,
  decodePayload,
  decryptDraft,
  encodePayload,
  encryptDraft,
  EasOffchainError,
  importBundle,
  loadEncryptedDraft,
  prefixHeads,
  rawCid,
  reloadAndReapply,
  saveEncryptedDraft,
  signEasV2Attestation,
  syncCanonicalNode,
  validateSignedBundle,
  ZERO32,
  type RecoverableDraft,
  type SignedAnchorBundle,
  type WalletTypedDataSigner,
} from '../src/index.ts'

const fixtureDir = resolve(__dirname, '../../../tests/fixtures/eas-offchain/v1')

type Manifest = {
  fixturePrivateKey: Hex
  owner: Address
  schemaUid: Hex
  easDomain: { version: string; chainId: string; verifyingContract: Address }
  headDomain: { verifyingContract: Address }
  positive: {
    cid: string
    dataCommitment: Hex
    payloadHex: Hex
    anchorHistory: Array<{
      authorization: {
        message: {
          nodeId: Hex
          envelopeKind: 0
          schemaUid: Hex
          previousHead: Hex
          head: Hex
          count: string
          dataCommitment: Hex
        }
        signature: Hex
      }
    }>
  }
}

const loadFixture = async () => {
  const manifest = JSON.parse(
    await readFile(resolve(fixtureDir, 'manifest.json'), 'utf8')
  ) as Manifest
  const bytes = new Uint8Array(
    await readFile(resolve(fixtureDir, 'payload.bin'))
  )
  return { manifest, bytes }
}

const walletFor = (privateKey: Hex): WalletTypedDataSigner => {
  const account = privateKeyToAccount(privateKey)
  return {
    address: account.address,
    signTypedData: (args) => account.signTypedData(args as never),
  }
}

const fixtureBundle = (manifest: Manifest): SignedAnchorBundle => {
  const authorization = manifest.positive.anchorHistory[1]!.authorization
  return {
    protocol: 'TrustgraphsEasOffchainBundleV1',
    chainId: manifest.easDomain.chainId,
    registry: manifest.headDomain.verifyingContract,
    eas: {
      address: manifest.easDomain.verifyingContract,
      version: manifest.easDomain.version,
    },
    schemaUid: manifest.schemaUid,
    owner: manifest.owner,
    payloadHex: manifest.positive.payloadHex,
    cid: manifest.positive.cid,
    dataCommitment: manifest.positive.dataCommitment,
    message: authorization.message,
    headSignature: authorization.signature,
  }
}

test('codec reproduces every frozen Envelope0PayloadV1 byte and CID', async () => {
  const { manifest, bytes } = await loadFixture()
  const payload = decodePayload(bytes, manifest.schemaUid)
  assert.equal(bytesToHex(encodePayload(payload)), manifest.positive.payloadHex)
  assert.equal(rawCid(manifest.positive.dataCommitment), manifest.positive.cid)
  assert.equal(
    prefixHeads(payload).at(-1),
    manifest.positive.anchorHistory[1]!.authorization.message.head
  )
})

test('official SDK verification accepts the frozen bundle and rejects a changed domain', async () => {
  const { manifest } = await loadFixture()
  const bundle = fixtureBundle(manifest)
  const validated = await validateSignedBundle(bundle)
  assert.equal(validated.payload.owner, manifest.owner)

  await assert.rejects(
    validateSignedBundle({ ...bundle, chainId: '1' }),
    (error: unknown) =>
      error instanceof EasOffchainError && error.code === 'E0_EAS_SIGNATURE'
  )
  assert.deepEqual(await importBundle(JSON.stringify(bundle)), bundle)
})

test('wallet honors a reviewed salt, randomizes by default, and builds a canonical bundle', async () => {
  const { manifest, bytes } = await loadFixture()
  const wallet = walletFor(manifest.fixturePrivateKey)
  const encoder = new SchemaEncoder('string comment,uint256 confidence')
  const data = encoder.encodeData([
    { name: 'comment', type: 'string', value: 'third edge' },
    { name: 'confidence', type: 'uint256', value: 88n },
  ]) as Hex
  const domain = {
    address: manifest.easDomain.verifyingContract,
    version: manifest.easDomain.version,
    chainId: BigInt(manifest.easDomain.chainId),
  }
  const reviewedSalt = `0x${'11'.repeat(32)}` as Hex
  const first = await signEasV2Attestation(
    {
      schema: manifest.schemaUid,
      recipient: '0x4444444444444444444444444444444444444444',
      time: 1_770_000_002n,
      data,
      salt: reviewedSalt,
    },
    domain,
    wallet
  )
  const second = await signEasV2Attestation(
    {
      schema: manifest.schemaUid,
      recipient: '0x4444444444444444444444444444444444444444',
      time: 1_770_000_002n,
      data,
    },
    domain,
    wallet
  )
  assert.equal(first.salt, reviewedSalt)
  assert.notEqual(first.salt, second.salt)
  assert.notEqual(first.uid, second.uid)

  const canonical = decodePayload(bytes, manifest.schemaUid)
  const payload = applyOperations(canonical, manifest.owner, [
    { kind: 'attest', attestation: first },
  ])
  const liveAuthorization = manifest.positive.anchorHistory[1]!.authorization
  const bundle = await createSignedBundle({
    payload,
    live: {
      count: BigInt(liveAuthorization.message.count),
      head: liveAuthorization.message.head,
      dataCommitment: liveAuthorization.message.dataCommitment,
    },
    schemaUid: manifest.schemaUid,
    eas: domain,
    registry: manifest.headDomain.verifyingContract,
    wallet,
  })
  assert.equal(bundle.message.count, '4')
  assert.equal(
    (await validateSignedBundle(bundle)).message.previousHead,
    liveAuthorization.message.head
  )
})

test('drafts are encrypted and stale drafts deterministically reload/reapply', async () => {
  const { manifest, bytes } = await loadFixture()
  const canonical = decodePayload(bytes, manifest.schemaUid)
  const revokeUid = canonical.entries[1]!.uid
  const base = {
    count: 3n,
    head: prefixHeads(canonical).at(-1)!,
    dataCommitment: manifest.positive.dataCommitment,
  }
  const draft: RecoverableDraft = {
    protocol: 'TrustgraphsEasOffchainDraftV1',
    chainId: manifest.easDomain.chainId,
    registry: manifest.headDomain.verifyingContract,
    schemaUid: manifest.schemaUid,
    owner: manifest.owner,
    base,
    operations: [{ kind: 'revoke', uid: revokeUid }],
    createdAt: '2026-08-21T00:00:00.000Z',
  }
  const encrypted = await encryptDraft(draft, 'correct horse battery staple')
  assert.equal(JSON.stringify(encrypted).includes(revokeUid), false)
  assert.deepEqual(
    await decryptDraft(encrypted, 'correct horse battery staple'),
    draft
  )
  await assert.rejects(decryptDraft(encrypted, 'incorrect passphrase'))

  const advanced = applyOperations(canonical, manifest.owner, [])
  assert.throws(
    () => assertSyncedBeforeEdit(draft, { ...base, count: 4n }),
    (error: unknown) =>
      error instanceof EasOffchainError && error.code === 'E0_CONFLICT'
  )
  const reapplied = applyOperations(advanced, manifest.owner, draft.operations)
  assert.deepEqual(reapplied.entries.at(-1), { kind: 1, uid: revokeUid })

  const local = new Map<string, string>()
  const storage = {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => void local.set(key, value),
  }
  await saveEncryptedDraft(
    storage,
    'draft',
    draft,
    'correct horse battery staple'
  )
  assert.equal(local.get('draft')?.includes(revokeUid), false)
  assert.deepEqual(
    await loadEncryptedDraft(storage, 'draft', 'correct horse battery staple'),
    draft
  )

  const source = {
    readLive: async () => base,
    readPayload: async (cid: string) => {
      assert.equal(cid, manifest.positive.cid)
      return bytes
    },
  }
  const sync = await syncCanonicalNode({
    source,
    owner: manifest.owner,
    schemaUid: manifest.schemaUid,
  })
  assert.equal(sync.cid, manifest.positive.cid)
  const recovered = await reloadAndReapply(draft, source)
  assert.deepEqual(recovered.payload.entries.at(-1), {
    kind: 1,
    uid: revokeUid,
  })
})
