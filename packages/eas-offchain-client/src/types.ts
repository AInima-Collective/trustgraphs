import type { Address, Hex } from 'viem'

export type EasDomain = {
  address: Address
  version: string
  chainId: bigint
}

export type LogEntry = {
  kind: 0 | 1
  uid: Hex
}

export type CanonicalAttestation = {
  version: 2
  schema: Hex
  recipient: Address
  time: bigint
  expirationTime: 0n
  revocable: true
  refUID: Hex
  data: Hex
  salt: Hex
  signature: Hex
  uid: Hex
}

export type PayloadV1 = {
  owner: Address
  entries: LogEntry[]
  attestations: CanonicalAttestation[]
}

export type LiveNodeHead = {
  count: bigint
  head: Hex
  dataCommitment: Hex
}

export type AnchorMessage = {
  nodeId: Hex
  envelopeKind: 0
  schemaUid: Hex
  previousHead: Hex
  head: Hex
  count: bigint
  dataCommitment: Hex
}

export type WalletTypedDataSigner = {
  address: Address
  signTypedData(args: {
    domain: {
      name?: string
      version?: string
      chainId?: number | bigint
      verifyingContract?: Address
    }
    types: Record<string, readonly { name: string; type: string }[]>
    primaryType: string
    message: Record<string, unknown>
  }): Promise<Hex>
}

export type SignedAnchorBundle = {
  protocol: 'TrustgraphsEasOffchainBundleV1'
  chainId: string
  registry: Address
  eas: {
    address: Address
    version: string
  }
  schemaUid: Hex
  owner: Address
  payloadHex: Hex
  cid: string
  dataCommitment: Hex
  message: Omit<AnchorMessage, 'count'> & { count: string }
  headSignature: Hex
}

export type DraftOperation =
  | { kind: 'attest'; attestation: CanonicalAttestation }
  | { kind: 'revoke'; uid: Hex }

export type RecoverableDraft = {
  protocol: 'TrustgraphsEasOffchainDraftV1'
  chainId: string
  registry: Address
  schemaUid: Hex
  owner: Address
  base: LiveNodeHead
  operations: DraftOperation[]
  createdAt: string
}

export type EncryptedDraft = {
  protocol: 'TrustgraphsEncryptedDraftV1'
  kdf: 'PBKDF2-SHA256'
  iterations: number
  salt: string
  cipher: 'AES-256-GCM'
  iv: string
  ciphertext: string
}
