import {
  EAS,
  Offchain,
  OFFCHAIN_ATTESTATION_TYPES,
  OffchainAttestationVersion,
  type SignedOffchainAttestation,
} from '@ethereum-attestation-service/eas-sdk'
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem'

import { bytesToHex, concatBytes, hexToBytes, ZERO32 } from './bytes.ts'
import {
  assertCanonicalProfileData,
  assertCanonicalSignature,
} from './codec.ts'
import { fail } from './errors.ts'
import type {
  AnchorMessage,
  CanonicalAttestation,
  EasDomain,
  WalletTypedDataSigner,
} from './types.ts'

export const HEAD_TYPES = {
  Anchor: [
    { name: 'nodeId', type: 'bytes32' },
    { name: 'envelopeKind', type: 'uint8' },
    { name: 'schemaUid', type: 'bytes32' },
    { name: 'previousHead', type: 'bytes32' },
    { name: 'head', type: 'bytes32' },
    { name: 'count', type: 'uint64' },
    { name: 'dataCommitment', type: 'bytes32' },
  ],
} as const

/** Generate the non-zero salt that is part of the exact EAS v2 typed message. */
export const randomAttestationSalt = (): Hex => {
  const salt = new Uint8Array(32)
  globalThis.crypto.getRandomValues(salt)
  if (salt.every((byte) => byte === 0)) globalThis.crypto.getRandomValues(salt)
  if (salt.every((byte) => byte === 0))
    fail('E0_ZERO_SALT', 'secure random source returned zero salt')
  return bytesToHex(salt)
}

const sdkSigner = (wallet: WalletTypedDataSigner) => ({
  getAddress: async () => wallet.address,
  signTypedData: async (
    domain: Record<string, unknown>,
    types: Record<string, readonly { name: string; type: string }[]>,
    message: Record<string, unknown>
  ) =>
    wallet.signTypedData({
      domain: domain as Parameters<
        WalletTypedDataSigner['signTypedData']
      >[0]['domain'],
      types,
      primaryType: 'Attest',
      message,
    }),
})

const signatureHex = (signed: SignedOffchainAttestation): Hex => {
  const value = concatBytes(
    hexToBytes(signed.signature.r as Hex),
    hexToBytes(signed.signature.s as Hex),
    new Uint8Array([signed.signature.v])
  )
  const signature = bytesToHex(value)
  assertCanonicalSignature(signature)
  return signature
}

export const signEasV2Attestation = async (
  input: {
    schema: Hex
    recipient: Address
    time: bigint
    data: Hex
    /** Optional so review UIs can show the exact typed message before opening the wallet. */
    salt?: Hex
  },
  domain: EasDomain,
  wallet: WalletTypedDataSigner
): Promise<CanonicalAttestation> => {
  assertCanonicalProfileData(input.data)
  const salt = input.salt ?? randomAttestationSalt()
  if (salt === ZERO32) fail('E0_ZERO_SALT', 'attestation salt must be non-zero')
  const eas = new EAS(domain.address)
  const offchain = new Offchain(
    domain,
    OffchainAttestationVersion.Version2,
    eas
  )
  const signed = await offchain.signOffchainAttestation(
    {
      schema: input.schema,
      recipient: input.recipient,
      time: input.time,
      data: input.data,
      expirationTime: 0n,
      revocable: true,
      refUID: ZERO32,
      salt,
    },
    sdkSigner(wallet) as never
  )
  return {
    version: 2,
    schema: input.schema,
    recipient: getAddress(input.recipient),
    time: input.time,
    expirationTime: 0n,
    revocable: true,
    refUID: ZERO32,
    data: input.data,
    salt,
    signature: signatureHex(signed),
    uid: signed.uid as Hex,
  }
}

const splitSignature = (signature: Hex) => {
  assertCanonicalSignature(signature)
  const bytes = hexToBytes(signature)
  return {
    r: bytesToHex(bytes.slice(0, 32)),
    s: bytesToHex(bytes.slice(32, 64)),
    v: bytes[64]!,
  }
}

export const verifyEasV2Attestation = (
  attestation: CanonicalAttestation,
  owner: Address,
  domain: EasDomain
): boolean => {
  const offchain = new Offchain(
    domain,
    OffchainAttestationVersion.Version2,
    new EAS(domain.address)
  )
  const signingType =
    OFFCHAIN_ATTESTATION_TYPES[OffchainAttestationVersion.Version2][0]!
  const signed: SignedOffchainAttestation = {
    version: OffchainAttestationVersion.Version2,
    uid: attestation.uid,
    domain: offchain.getDomainTypedData(),
    primaryType: signingType.primaryType,
    types: signingType.types,
    message: {
      version: OffchainAttestationVersion.Version2,
      schema: attestation.schema,
      recipient: attestation.recipient,
      time: attestation.time,
      expirationTime: attestation.expirationTime,
      revocable: attestation.revocable,
      refUID: attestation.refUID,
      data: attestation.data,
      salt: attestation.salt,
    },
    signature: splitSignature(attestation.signature),
  }
  return offchain.verifyOffchainAttestationSignature(owner, signed)
}

export const headDomain = (chainId: bigint, registry: Address) =>
  ({
    name: 'Trustgraphs Offchain Head',
    version: '2',
    chainId,
    verifyingContract: registry,
  }) as const

export const domainSeparator = (domain: {
  name: string
  version: string
  chainId: bigint
  verifyingContract: Address
}): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        keccak256(
          new TextEncoder().encode(
            'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
          )
        ),
        keccak256(new TextEncoder().encode(domain.name)),
        keccak256(new TextEncoder().encode(domain.version)),
        domain.chainId,
        domain.verifyingContract,
      ]
    )
  )

export const signHead = async (
  message: AnchorMessage,
  chainId: bigint,
  registry: Address,
  wallet: WalletTypedDataSigner
): Promise<Hex> => {
  const signature = await wallet.signTypedData({
    domain: headDomain(chainId, registry),
    types: HEAD_TYPES,
    primaryType: 'Anchor',
    message,
  })
  assertCanonicalSignature(signature)
  return signature
}

export const recoverHeadSigner = (
  message: AnchorMessage,
  signature: Hex,
  chainId: bigint,
  registry: Address
): Promise<Address> => {
  assertCanonicalSignature(signature)
  return recoverTypedDataAddress({
    domain: headDomain(chainId, registry),
    types: HEAD_TYPES,
    primaryType: 'Anchor',
    message,
    signature,
  })
}
