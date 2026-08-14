import { NextRequest, NextResponse } from 'next/server'
import {
  type Abi,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  isHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { easAbi } from '@/lib/contract-abis'
import {
  EAS_DELEGATION_TTL_SECONDS,
  EAS_DELEGATION_VERSION,
  type EasRelayAttestationData,
  type EasRelayAttestationGroup,
  MAX_RELAY_ATTESTATIONS,
  easDelegatedAttestMessage,
  easDelegatedAttestTypes,
  easDelegationDomain,
  joinEasRelaySignature,
} from '@/lib/eas-delegation'

export const runtime = 'nodejs'

const MAX_BODY_BYTES = 128 * 1024
const MAX_DATA_BYTES = 32 * 1024
const requestsByIp = new Map<string, { window: number; count: number }>()

class RelayRequestError extends Error {}

const decimal = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)

const bytes32 = (value: unknown): value is Hex =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)

const address = (value: unknown): value is Address =>
  typeof value === 'string' && isAddress(value)

const rateLimited = (request: NextRequest): boolean => {
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const window = Math.floor(Date.now() / 60_000)
  const current = requestsByIp.get(ip)
  if (!current || current.window !== window) {
    if (requestsByIp.size >= 1_000) {
      for (const [key, value] of requestsByIp) {
        if (value.window !== window) requestsByIp.delete(key)
      }
      if (requestsByIp.size >= 10_000) return true
    }
    requestsByIp.set(ip, { window, count: 1 })
    return false
  }
  current.count += 1
  return current.count > 10
}

const relayConfig = () => {
  const chainId = Number(process.env.EAS_RELAY_CHAIN_ID)
  const eas = process.env.EAS_RELAY_ADDRESS
  const rpc = process.env.EAS_RELAY_RPC_URL ?? process.env[`RPC_URL_${chainId}`]
  const privateKey = process.env.EAS_RELAY_PRIVATE_KEY
  const schemas = new Set(
    (process.env.EAS_RELAY_SCHEMA_ALLOWLIST ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  )
  if (
    !Number.isSafeInteger(chainId) ||
    chainId <= 0 ||
    !eas ||
    !isAddress(eas) ||
    !rpc ||
    !privateKey ||
    !/^0x[0-9a-fA-F]{64}$/.test(privateKey) ||
    schemas.size === 0
  ) {
    return null
  }
  return {
    chainId,
    eas: eas as Address,
    rpc,
    privateKey: privateKey as Hex,
    schemas,
  }
}

const parseGroup = (
  raw: unknown,
  allowedSchemas: Set<string>,
  now: bigint
): EasRelayAttestationGroup => {
  if (!raw || typeof raw !== 'object') {
    throw new RelayRequestError('Invalid request group')
  }
  const group = raw as Record<string, unknown>
  if (
    !bytes32(group.schema) ||
    !allowedSchemas.has(group.schema.toLowerCase())
  ) {
    throw new RelayRequestError('Schema is not relay-allowlisted')
  }
  if (!address(group.attester)) throw new RelayRequestError('Invalid attester')
  if (!decimal(group.deadline)) throw new RelayRequestError('Invalid deadline')
  const deadline = BigInt(group.deadline)
  if (deadline < now || deadline > now + EAS_DELEGATION_TTL_SECONDS) {
    throw new RelayRequestError(
      'Signature deadline is expired or too far in the future'
    )
  }
  if (
    !Array.isArray(group.data) ||
    !Array.isArray(group.signatures) ||
    !Array.isArray(group.nonces) ||
    group.data.length === 0 ||
    group.data.length !== group.signatures.length ||
    group.data.length !== group.nonces.length
  ) {
    throw new RelayRequestError(
      'Data, signatures, and nonces must have equal non-zero length'
    )
  }

  const data = group.data.map((rawData): EasRelayAttestationData => {
    if (!rawData || typeof rawData !== 'object') {
      throw new RelayRequestError('Invalid attestation data')
    }
    const value = rawData as Record<string, unknown>
    if (
      !address(value.recipient) ||
      !decimal(value.expirationTime) ||
      typeof value.revocable !== 'boolean' ||
      !bytes32(value.refUID) ||
      typeof value.data !== 'string' ||
      !isHex(value.data) ||
      (value.data.length - 2) / 2 > MAX_DATA_BYTES ||
      value.value !== '0'
    ) {
      throw new RelayRequestError('Invalid or non-zero-value attestation')
    }
    if (BigInt(value.expirationTime) > (1n << 64n) - 1n) {
      throw new RelayRequestError('Expiration exceeds uint64')
    }
    return {
      recipient: value.recipient,
      expirationTime: value.expirationTime,
      revocable: value.revocable,
      refUID: value.refUID,
      data: value.data,
      value: value.value,
    }
  })

  const signatures = group.signatures.map((rawSignature) => {
    if (!rawSignature || typeof rawSignature !== 'object') {
      throw new RelayRequestError('Invalid signature')
    }
    const signature = rawSignature as Record<string, unknown>
    if (
      (signature.v !== 27 && signature.v !== 28) ||
      !bytes32(signature.r) ||
      !bytes32(signature.s)
    ) {
      throw new RelayRequestError('Invalid signature')
    }
    return { v: signature.v, r: signature.r, s: signature.s }
  })
  const nonces = group.nonces.map((nonce) => {
    if (!decimal(nonce)) throw new RelayRequestError('Invalid nonce')
    return nonce
  })

  return {
    schema: group.schema,
    data,
    signatures,
    nonces,
    attester: group.attester,
    deadline: group.deadline,
  }
}

export async function POST(request: NextRequest) {
  if (rateLimited(request)) {
    return NextResponse.json(
      { error: 'Relay rate limit exceeded' },
      { status: 429 }
    )
  }
  const config = relayConfig()
  if (!config) {
    return NextResponse.json(
      { error: 'EAS relay is not configured' },
      { status: 503 }
    )
  }

  try {
    const rawBody = await request.text()
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES)
      throw new RelayRequestError('Relay request is too large')
    const body = JSON.parse(rawBody) as Record<string, unknown>
    if (
      body.kind !== 'attest' ||
      body.chainId !== config.chainId ||
      !address(body.eas) ||
      body.eas.toLowerCase() !== config.eas.toLowerCase() ||
      !Array.isArray(body.requests)
    ) {
      throw new RelayRequestError('Relay chain or contract mismatch')
    }

    const now = BigInt(Math.floor(Date.now() / 1000))
    const requests = body.requests.map((group) =>
      parseGroup(group, config.schemas, now)
    )
    const count = requests.reduce((sum, group) => sum + group.data.length, 0)
    if (count === 0 || count > MAX_RELAY_ATTESTATIONS) {
      throw new RelayRequestError(
        `Relay batches support 1-${MAX_RELAY_ATTESTATIONS} attestations`
      )
    }

    const chain = defineChain({
      id: config.chainId,
      name: 'EAS relay chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [config.rpc] } },
    })
    const publicClient = createPublicClient({
      chain,
      transport: http(config.rpc),
    })
    const account = privateKeyToAccount(config.privateKey)
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(config.rpc),
    })

    const version = await publicClient.readContract({
      address: config.eas,
      abi: easAbi,
      functionName: 'version',
    })
    if (version !== EAS_DELEGATION_VERSION) {
      throw new RelayRequestError(
        `Unsupported EAS delegation version ${version}`
      )
    }

    const expectedNonce = new Map<Address, bigint>()
    for (const group of requests) {
      let nonce = expectedNonce.get(group.attester)
      if (nonce === undefined) {
        nonce = await publicClient.readContract({
          address: config.eas,
          abi: easAbi,
          functionName: 'getNonce',
          args: [group.attester],
        })
      }
      for (let i = 0; i < group.data.length; i += 1) {
        if (BigInt(group.nonces[i]!) !== nonce) {
          throw new RelayRequestError('Stale or non-sequential EAS nonce')
        }
        const valid = await publicClient.verifyTypedData({
          address: group.attester,
          domain: easDelegationDomain(config.chainId, config.eas, version),
          types: easDelegatedAttestTypes,
          primaryType: 'Attest',
          message: easDelegatedAttestMessage({
            attester: group.attester,
            schema: group.schema,
            data: group.data[i]!,
            nonce,
            deadline: BigInt(group.deadline),
          }),
          signature: joinEasRelaySignature(group.signatures[i]!),
        })
        if (!valid) {
          throw new RelayRequestError('Invalid delegated attestation signature')
        }
        nonce += 1n
      }
      expectedNonce.set(group.attester, nonce)
    }

    const contractRequests = requests.map((group) => ({
      schema: group.schema,
      data: group.data.map((data) => ({
        recipient: data.recipient,
        expirationTime: BigInt(data.expirationTime),
        revocable: data.revocable,
        refUID: data.refUID,
        data: data.data,
        value: 0n,
      })),
      signatures: group.signatures,
      attester: group.attester,
      deadline: BigInt(group.deadline),
    }))
    const { request: transaction } = await publicClient.simulateContract({
      account,
      address: config.eas,
      // The generated full EAS ABI makes viem intersect this nested-tuple argument with a
      // spurious `never[]` overload. The runtime ABI is exact; widen only this call boundary.
      abi: easAbi as Abi,
      functionName: 'multiAttestByDelegation',
      args: [contractRequests],
    })
    const hash = await walletClient.writeContract(transaction)
    return NextResponse.json({ hash })
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (error instanceof RelayRequestError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    // Do not echo viem/RPC errors: their diagnostic text can contain an authenticated RPC URL.
    console.error(
      'EAS relay execution failed:',
      error instanceof Error ? error.name : 'unknown error'
    )
    return NextResponse.json(
      { error: 'EAS relay execution failed' },
      { status: 502 }
    )
  }
}
