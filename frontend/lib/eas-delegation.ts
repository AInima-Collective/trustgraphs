import {
  type Address,
  type Hex,
  parseSignature,
  serializeSignature,
} from 'viem'

export const EAS_DELEGATION_VERSION = '1.3.0'
export const EAS_DELEGATION_TTL_SECONDS = 15n * 60n
export const MAX_RELAY_ATTESTATIONS = 20

export const easDelegatedAttestTypes = {
  Attest: [
    { name: 'attester', type: 'address' },
    { name: 'schema', type: 'bytes32' },
    { name: 'recipient', type: 'address' },
    { name: 'expirationTime', type: 'uint64' },
    { name: 'revocable', type: 'bool' },
    { name: 'refUID', type: 'bytes32' },
    { name: 'data', type: 'bytes' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const

export interface EasRelayAttestationData {
  recipient: Address
  expirationTime: string
  revocable: boolean
  refUID: Hex
  data: Hex
  value: string
}

export interface EasRelaySignature {
  v: number
  r: Hex
  s: Hex
}

export interface EasRelayAttestationGroup {
  schema: Hex
  data: EasRelayAttestationData[]
  signatures: EasRelaySignature[]
  nonces: string[]
  attester: Address
  deadline: string
}

export interface EasRelayAttestationPayload {
  kind: 'attest'
  chainId: number
  eas: Address
  requests: EasRelayAttestationGroup[]
}

export const easDelegationDomain = (
  chainId: number,
  eas: Address,
  version = EAS_DELEGATION_VERSION
) =>
  ({
    name: 'EAS',
    version,
    chainId,
    verifyingContract: eas,
  }) as const

export const easDelegatedAttestMessage = (args: {
  attester: Address
  schema: Hex
  data: EasRelayAttestationData
  nonce: bigint
  deadline: bigint
}) => ({
  attester: args.attester,
  schema: args.schema,
  recipient: args.data.recipient,
  expirationTime: BigInt(args.data.expirationTime),
  revocable: args.data.revocable,
  refUID: args.data.refUID,
  data: args.data.data,
  value: BigInt(args.data.value),
  nonce: args.nonce,
  deadline: args.deadline,
})

export const splitEasRelaySignature = (signature: Hex): EasRelaySignature => {
  const parsed = parseSignature(signature)
  const v = parsed.v ?? BigInt(27 + (parsed.yParity ?? 0))
  return { v: Number(v), r: parsed.r, s: parsed.s }
}

export const joinEasRelaySignature = (signature: EasRelaySignature): Hex =>
  serializeSignature({
    v: BigInt(signature.v),
    r: signature.r,
    s: signature.s,
  })

export const countRelayAttestations = (requests: EasRelayAttestationGroup[]) =>
  requests.reduce((count, request) => count + request.data.length, 0)
