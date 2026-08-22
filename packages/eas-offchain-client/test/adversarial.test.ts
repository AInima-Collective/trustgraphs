import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

import type { Address, Hex } from 'viem'

import {
  assertNoFutureAttestations,
  bytesToHex,
  decodePayload,
  EasOffchainError,
  hexToBytes,
  MAX_PAYLOAD_BYTES,
  validateSignedBundle,
  type SignedAnchorBundle,
} from '../src/index.ts'

const fixtureDir = resolve(__dirname, '../../../test/fixtures/eas-offchain/v1')
const SECP256K1_N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
)

type Authorization = {
  message: SignedAnchorBundle['message']
  signature: Hex
}

type Negative = {
  name: string
  expectedReason: string
  payloadFile: string
  actualCommitment: Hex
  claimedCommitment: Hex
  cid: string
  anchorTimestamp: string
  authorization: Authorization
}

type Manifest = {
  owner: Address
  schemaUid: Hex
  easDomain: { version: string; chainId: string; verifyingContract: Address }
  headDomain: { verifyingContract: Address }
  positive: {
    anchorHistory: Array<{
      payloadHex: Hex
      cid: string
      dataCommitment: Hex
      authorization: Authorization
    }>
  }
  negatives: Negative[]
}

const loadManifest = async (): Promise<Manifest> =>
  JSON.parse(
    await readFile(resolve(fixtureDir, 'manifest.json'), 'utf8')
  ) as Manifest

const bundle = (
  manifest: Manifest,
  args: {
    payloadHex: Hex
    cid: string
    dataCommitment: Hex
    authorization: Authorization
  }
): SignedAnchorBundle => ({
  protocol: 'TrustgraphsEasOffchainBundleV1',
  chainId: manifest.easDomain.chainId,
  registry: manifest.headDomain.verifyingContract,
  eas: {
    address: manifest.easDomain.verifyingContract,
    version: manifest.easDomain.version,
  },
  schemaUid: manifest.schemaUid,
  owner: manifest.owner,
  payloadHex: args.payloadHex,
  cid: args.cid,
  dataCommitment: args.dataCommitment,
  message: args.authorization.message,
  headSignature: args.authorization.signature,
})

const expectCode =
  (expected: string) =>
  (error: unknown): boolean => {
    assert.ok(error instanceof EasOffchainError)
    assert.equal(error.code, expected)
    return true
  }

const highS = (signature: Hex): Hex => {
  const value = hexToBytes(signature)
  const s = BigInt(bytesToHex(value.slice(32, 64)))
  const changed = new Uint8Array(value)
  const nextS = (SECP256K1_N - s).toString(16).padStart(64, '0')
  changed.set(hexToBytes(`0x${nextS}`), 32)
  changed[64] = value[64] === 27 ? 28 : 27
  return bytesToHex(changed)
}

test('the full official-SDK negative corpus fails at its frozen rule', async () => {
  const manifest = await loadManifest()
  for (const negative of manifest.negatives) {
    const payloadHex = bytesToHex(
      new Uint8Array(await readFile(resolve(fixtureDir, negative.payloadFile)))
    )
    const candidate = bundle(manifest, {
      payloadHex,
      cid: negative.cid,
      dataCommitment: negative.claimedCommitment,
      authorization: negative.authorization,
    })
    if (negative.name === 'future-time') {
      const validated = await validateSignedBundle(candidate)
      assert.throws(
        () =>
          assertNoFutureAttestations(
            validated.payload,
            BigInt(negative.anchorTimestamp)
          ),
        expectCode(negative.expectedReason)
      )
      continue
    }
    await assert.rejects(
      validateSignedBundle(candidate),
      expectCode(negative.expectedReason),
      negative.name
    )
  }
})

test('truncated, oversized, and trailing payload bodies fail before signature recovery', async () => {
  const manifest = await loadManifest()
  const payload = hexToBytes(manifest.positive.anchorHistory[0]!.payloadHex)
  assert.throws(
    () => decodePayload(payload.slice(0, -1), manifest.schemaUid),
    expectCode('E0_TRUNCATED')
  )
  assert.throws(
    () =>
      decodePayload(new Uint8Array(MAX_PAYLOAD_BYTES + 1), manifest.schemaUid),
    expectCode('E0_PAYLOAD_LIMIT')
  )
  assert.throws(
    () => decodePayload(new Uint8Array([...payload, 0]), manifest.schemaUid),
    expectCode('E0_TRAILING_BYTES')
  )
})

test('head signature malleability and replay into another registry fail closed', async () => {
  const manifest = await loadManifest()
  const first = manifest.positive.anchorHistory[0]!
  const canonical = bundle(manifest, {
    payloadHex: first.payloadHex,
    cid: first.cid,
    dataCommitment: first.dataCommitment,
    authorization: first.authorization,
  })
  await assert.rejects(
    validateSignedBundle({
      ...canonical,
      headSignature: highS(canonical.headSignature),
    }),
    expectCode('E0_SIGNATURE_FORM')
  )
  await assert.rejects(
    validateSignedBundle({
      ...canonical,
      registry: '0x9999999999999999999999999999999999999999',
    }),
    expectCode('E0_HEAD_SIGNATURE')
  )
})
