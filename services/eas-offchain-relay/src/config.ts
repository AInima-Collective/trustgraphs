import { getAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { IpfsTargetConfig } from './ipfs.ts'
import type { RelayConfig } from './types.ts'

export type RuntimeConfig = {
  relay: RelayConfig
  rpcUrl: string
  relayerPrivateKey: Hex
  ipfsTargets: IpfsTargetConfig[]
  allowedOrigins: ReadonlySet<string>
  host: string
  port: number
}

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const integer = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number
): number => {
  const value = Number(env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${name} must be an integer >= ${minimum}`)
  return value
}

const address = (env: NodeJS.ProcessEnv, name: string): Address =>
  getAddress(required(env, name))

const bytes32 = (env: NodeJS.ProcessEnv, name: string): Hex => {
  const value = required(env, name)
  if (!/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error(`${name} must be bytes32 hex`)
  return value.toLowerCase() as Hex
}

const csvSet = (value: string | undefined): ReadonlySet<string> =>
  new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  )

const ipfsTargets = (env: NodeJS.ProcessEnv): IpfsTargetConfig[] => {
  let value: unknown
  try {
    value = JSON.parse(required(env, 'IPFS_TARGETS_JSON'))
  } catch {
    throw new Error('IPFS_TARGETS_JSON must be valid JSON')
  }
  if (!Array.isArray(value) || value.length < 2)
    throw new Error('IPFS_TARGETS_JSON must contain at least two targets')
  const targets = value.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as { name?: unknown }).name !== 'string' ||
      typeof (entry as { apiUrl?: unknown }).apiUrl !== 'string'
    )
      throw new Error('each IPFS target requires name and apiUrl strings')
    const target = entry as {
      name: string
      apiUrl: string
      authHeader?: unknown
    }
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(target.name))
      throw new Error('IPFS target names must use 1-64 safe label characters')
    new URL(target.apiUrl)
    return {
      name: target.name,
      apiUrl: target.apiUrl,
      ...(typeof target.authHeader === 'string'
        ? { authHeader: target.authHeader }
        : {}),
    }
  })
  if (new Set(targets.map((target) => target.name)).size !== targets.length)
    throw new Error('IPFS target names must be distinct')
  return targets
}

export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env
): RuntimeConfig => {
  const targets = ipfsTargets(env)
  const relayerPrivateKey = required(env, 'RELAYER_PRIVATE_KEY')
  if (!/^0x[0-9a-fA-F]{64}$/.test(relayerPrivateKey))
    throw new Error('RELAYER_PRIVATE_KEY must be 32-byte hex')
  const relayerAddress = privateKeyToAccount(relayerPrivateKey as Hex).address
  const storageQuorum = integer(env, 'STORAGE_QUORUM', 2, 2)
  if (storageQuorum > targets.length)
    throw new Error('STORAGE_QUORUM exceeds target count')
  const chainId = BigInt(required(env, 'CHAIN_ID'))
  if (chainId <= 0n) throw new Error('CHAIN_ID must be positive')
  return {
    relay: {
      chainId,
      registry: address(env, 'REGISTRY_ADDRESS'),
      relayerAddress,
      schemaUid: bytes32(env, 'SCHEMA_UID'),
      easAddress: address(env, 'EAS_ADDRESS'),
      easVersion: required(env, 'EAS_VERSION'),
      allowedNodeIds: csvSet(env.ALLOWED_NODE_IDS),
      storageQuorum,
      maxBodyBytes: integer(env, 'MAX_BODY_BYTES', 2_300_000, 1),
      maxPayloadBytes: integer(env, 'MAX_PAYLOAD_BYTES', 1_048_576, 1),
      nodeRequestsPerMinute: integer(env, 'NODE_REQUESTS_PER_MINUTE', 6, 1),
    },
    rpcUrl: required(env, 'RPC_URL'),
    relayerPrivateKey: relayerPrivateKey as Hex,
    ipfsTargets: targets,
    allowedOrigins: csvSet(env.ALLOWED_ORIGINS),
    host: env.HOST ?? '0.0.0.0',
    port: integer(env, 'PORT', 8787, 1),
  }
}
