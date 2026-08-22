import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  sha256,
  type Address,
  type Hex,
} from 'viem'

import { bytesToHex, equalBytes, hexToBytes, ZERO32 } from './bytes.ts'
import { decodePayload, encodePayload, MAX_ENTRIES_PER_NODE } from './codec.ts'
import { fail } from './errors.ts'
import {
  recoverHeadSigner,
  signHead,
  verifyEasV2Attestation,
} from './signing.ts'
import type {
  AnchorMessage,
  EasDomain,
  LiveNodeHead,
  PayloadV1,
  SignedAnchorBundle,
  WalletTypedDataSigner,
} from './types.ts'

export const addressNodeId = (owner: Address): Hex =>
  keccak256(encodeAbiParameters([{ type: 'address' }], [owner]))

export const entryLeaf = (kind: 0 | 1, uid: Hex): Hex =>
  keccak256(
    encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes32' }], [kind, uid])
  )

export const prefixHeads = (payload: Pick<PayloadV1, 'entries'>): Hex[] => {
  const heads: Hex[] = []
  let head = ZERO32
  for (const entry of payload.entries) {
    head = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }],
        [head, entryLeaf(entry.kind, entry.uid)]
      )
    )
    heads.push(head)
  }
  return heads
}

const base32LowerNoPadding = (value: Uint8Array): string => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let accumulator = 0
  let bits = 0
  let out = ''
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += alphabet[(accumulator >>> bits) & 31]
    }
  }
  if (bits > 0) out += alphabet[(accumulator << (5 - bits)) & 31]
  return out
}

export const rawCid = (commitment: Hex): string => {
  const digest = hexToBytes(commitment)
  if (digest.length !== 32)
    fail('E0_COMMITMENT', 'SHA-256 commitment must be 32 bytes')
  const multicodec = new Uint8Array(36)
  multicodec.set([0x01, 0x55, 0x12, 0x20])
  multicodec.set(digest, 4)
  return `b${base32LowerNoPadding(multicodec)}`
}

export const payloadCommitment = (payload: Uint8Array): Hex => sha256(payload)

export const buildNextMessage = (
  payload: PayloadV1,
  schemaUid: Hex,
  live: LiveNodeHead
): { bytes: Uint8Array; cid: string; message: AnchorMessage } => {
  const count = BigInt(payload.entries.length)
  if (count <= live.count || count > BigInt(MAX_ENTRIES_PER_NODE))
    fail(
      'E0_COUNT_MISMATCH',
      'next payload count must strictly extend live count'
    )
  const heads = prefixHeads(payload)
  const prefixHead = live.count === 0n ? ZERO32 : heads[Number(live.count) - 1]
  if (prefixHead !== live.head)
    fail('E0_PREVIOUS_HEAD', 'payload does not extend the canonical live head')
  const bytes = encodePayload(payload)
  const dataCommitment = payloadCommitment(bytes)
  return {
    bytes,
    cid: rawCid(dataCommitment),
    message: {
      nodeId: addressNodeId(payload.owner),
      envelopeKind: 0,
      schemaUid,
      previousHead: live.head,
      head: heads.at(-1)!,
      count,
      dataCommitment,
    },
  }
}

export const createSignedBundle = async (args: {
  payload: PayloadV1
  live: LiveNodeHead
  schemaUid: Hex
  eas: EasDomain
  registry: Address
  wallet: WalletTypedDataSigner
}): Promise<SignedAnchorBundle> => {
  if (getAddress(args.wallet.address) !== getAddress(args.payload.owner))
    fail('E0_NODE_ID', 'wallet does not own the payload node')
  const next = buildNextMessage(args.payload, args.schemaUid, args.live)
  const headSignature = await signHead(
    next.message,
    args.eas.chainId,
    args.registry,
    args.wallet
  )
  return {
    protocol: 'TrustgraphsEasOffchainBundleV1',
    chainId: args.eas.chainId.toString(),
    registry: getAddress(args.registry),
    eas: { address: getAddress(args.eas.address), version: args.eas.version },
    schemaUid: args.schemaUid,
    owner: getAddress(args.payload.owner),
    payloadHex: bytesToHex(next.bytes),
    cid: next.cid,
    dataCommitment: next.message.dataCommitment,
    message: { ...next.message, count: next.message.count.toString() },
    headSignature,
  }
}

export const parseAnchorMessage = (
  bundle: SignedAnchorBundle
): AnchorMessage => ({
  ...bundle.message,
  count: BigInt(bundle.message.count),
})

export const validateSignedBundle = async (
  bundle: SignedAnchorBundle
): Promise<{
  payload: PayloadV1
  bytes: Uint8Array
  message: AnchorMessage
}> => {
  if (bundle.protocol !== 'TrustgraphsEasOffchainBundleV1')
    fail('E0_CANONICAL', 'unsupported bundle protocol')
  const chainId = BigInt(bundle.chainId)
  const bytes = hexToBytes(bundle.payloadHex)
  const payload = decodePayload(bytes, bundle.schemaUid)
  if (getAddress(payload.owner) !== getAddress(bundle.owner))
    fail('E0_NODE_ID', 'bundle owner does not match payload owner')
  if (!equalBytes(encodePayload(payload), bytes))
    fail('E0_CANONICAL', 'payload is not canonical')
  const commitment = payloadCommitment(bytes)
  if (
    commitment !== bundle.dataCommitment ||
    commitment !== bundle.message.dataCommitment
  )
    fail('E0_COMMITMENT', 'payload commitment mismatch')
  if (rawCid(commitment) !== bundle.cid)
    fail('E0_COMMITMENT', 'payload CID mismatch')
  const message = parseAnchorMessage(bundle)
  const heads = prefixHeads(payload)
  if (
    message.envelopeKind !== 0 ||
    message.schemaUid !== bundle.schemaUid ||
    message.count !== BigInt(payload.entries.length) ||
    message.head !== heads.at(-1) ||
    message.nodeId !== addressNodeId(payload.owner)
  )
    fail('E0_HEAD', 'anchor message does not match payload fold')
  if (
    message.previousHead !== ZERO32 &&
    !heads.slice(0, -1).includes(message.previousHead)
  )
    fail('E0_PREVIOUS_HEAD', 'previous head is not a payload prefix')
  const domain: EasDomain = {
    address: getAddress(bundle.eas.address),
    version: bundle.eas.version,
    chainId,
  }
  for (const attestation of payload.attestations) {
    if (!verifyEasV2Attestation(attestation, payload.owner, domain))
      fail(
        'E0_EAS_SIGNATURE',
        'EAS v2 signature does not recover payload owner'
      )
  }
  const signer = await recoverHeadSigner(
    message,
    bundle.headSignature,
    chainId,
    getAddress(bundle.registry)
  )
  if (getAddress(signer) !== getAddress(payload.owner))
    fail('E0_HEAD_SIGNATURE', 'head signature does not recover payload owner')
  return { payload, bytes, message }
}

export const exportBundle = (bundle: SignedAnchorBundle): string =>
  `${JSON.stringify(bundle, null, 2)}\n`

export const importBundle = async (
  json: string
): Promise<SignedAnchorBundle> => {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return fail('E0_CANONICAL', 'bundle is not valid JSON')
  }
  await validateSignedBundle(value as SignedAnchorBundle)
  return value as SignedAnchorBundle
}
