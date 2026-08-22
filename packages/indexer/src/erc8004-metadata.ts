import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import * as http from 'node:http'
import * as https from 'node:https'
import { isIP } from 'node:net'

import { type Hex, keccak256, toHex, zeroHash } from 'viem'

import { ERC8004_REGISTRATION_TYPE, erc8004RegistryKey } from './erc8004-shared'

export const ERC8004_METADATA_LIMITS = {
  timeoutMs: 5_000,
  maxBytes: 256 * 1024,
  maxRedirects: 3,
  maxServices: 32,
  maxRegistrations: 64,
  endpointConcurrency: 4,
} as const

export type DnsAnswer = { address: string; family: 4 | 6 }
export type DnsResolver = (hostname: string) => Promise<DnsAnswer[]>

export type SanitizedRegistration = {
  type: typeof ERC8004_REGISTRATION_TYPE
  name: string
  description: string
  image: string | null
  services: Array<{ name: string; endpoint: string; version?: string }>
  x402Support: boolean
  active: boolean
  registrations: Array<{ agentId: string; agentRegistry: string }>
  supportedTrust: string[]
}

export type EndpointObservation = {
  serviceName: string
  endpoint: string
  status: 'reachable' | 'unreachable' | 'unsupported_scheme' | 'blocked'
  httpStatus: number | null
  checkedAt: bigint
  latencyMs: number
  error: string | null
}

export type RegistrationFetchResult = {
  status: 'ok' | 'invalid' | 'unavailable' | 'blocked' | 'oversized'
  uri: string
  finalUri: string | null
  contentHash: string | null
  contentType: string | null
  byteLength: number | null
  httpStatus: number | null
  mutable: boolean
  fetchedAt: bigint
  error: string | null
  document: SanitizedRegistration | null
  endpointObservations: EndpointObservation[]
}

export type ReputationDocumentContext =
  | {
      kind: 'feedback'
      chainId: number
      identityRegistry: string
      agentId: bigint
      reviewer: Hex
      value: bigint
      valueDecimals: number
      tag: string
      unit: string
      endpoint: string
    }
  | { kind: 'response' }

export type ReputationDocumentFetchResult = Omit<
  RegistrationFetchResult,
  'document' | 'endpointObservations'
> & {
  document: Record<string, unknown> | null
  hashStatus: 'match' | 'omitted' | 'mismatch' | 'unverified'
}

class MetadataFetchError extends Error {
  constructor(
    readonly status: RegistrationFetchResult['status'],
    message: string,
    readonly details: Partial<RegistrationFetchResult> = {}
  ) {
    super(message)
  }
}

const ipv4Parts = (address: string): number[] | null => {
  if (isIP(address) !== 4) return null
  const parts = address.split('.').map(Number)
  return parts.length === 4 ? parts : null
}

/** Reject non-global destinations before every request and pin the connection to that answer. */
export const isBlockedIp = (address: string): boolean => {
  const v4 = ipv4Parts(address)
  if (v4) {
    const [a = 0, b = 0] = v4
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    )
  }

  if (isIP(address) !== 6) return true
  const normalized = address.toLowerCase().split('%')[0]!
  const mapped = normalized.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (mapped) return isBlockedIp(mapped)
  const halves = normalized.split('::')
  if (halves.length > 2) return true
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return true
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => '0'),
    ...right,
  ].map((part) => Number.parseInt(part || '0', 16))
  if (
    groups.length !== 8 ||
    groups.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)
  ) {
    return true
  }
  // IPv4-mapped hex form, e.g. ::ffff:7f00:1.
  if (groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff) {
    const high = groups[6]!
    const low = groups[7]!
    return isBlockedIp(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`)
  }
  const first = groups[0]!
  // Only globally routed 2000::/3 destinations are eligible. This excludes unspecified,
  // loopback, link-local, unique-local, multicast, and transition/reserved ranges.
  return (
    (first & 0xe000) !== 0x2000 ||
    (groups[0] === 0x2001 && groups[1] === 0x0db8)
  )
}

const defaultResolver: DnsResolver = async (hostname) => {
  if (isIP(hostname)) {
    return [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
  }
  const answers = await lookup(hostname, { all: true, verbatim: true })
  return answers.map(({ address, family }) => ({
    address,
    family: family as 4 | 6,
  }))
}

export const resolvePublicHost = async (
  url: URL,
  resolver: DnsResolver = defaultResolver
): Promise<DnsAnswer[]> => {
  if (url.protocol !== 'https:') {
    throw new MetadataFetchError(
      'blocked',
      'only HTTPS network fetches are allowed'
    )
  }
  if (url.username || url.password) {
    throw new MetadataFetchError('blocked', 'URI credentials are not allowed')
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  const answers = await Promise.race([
    resolver(url.hostname),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new MetadataFetchError(
              'unavailable',
              'hostname resolution timed out'
            )
          ),
        ERC8004_METADATA_LIMITS.timeoutMs
      )
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
  if (answers.length === 0) {
    throw new MetadataFetchError(
      'unavailable',
      'hostname returned no addresses'
    )
  }
  if (answers.some(({ address }) => isBlockedIp(address))) {
    throw new MetadataFetchError(
      'blocked',
      'hostname resolves to a private, loopback, link-local, or reserved address'
    )
  }
  return answers
}

type RawResponse = {
  status: number
  headers: http.IncomingHttpHeaders
  bytes: Buffer
  finalUrl: string
}

const requestOnce = async (
  url: URL,
  addresses: DnsAnswer[],
  method: 'GET' | 'HEAD',
  maxBytes: number
): Promise<Omit<RawResponse, 'finalUrl'>> =>
  new Promise((resolve, reject) => {
    const chosen = addresses[0]!
    const request = https.request(
      url,
      {
        method,
        headers: {
          accept: 'application/json, application/*+json',
          'user-agent': 'trustgraphs-erc8004-metadata/1',
        },
        lookup: (_hostname, _options, callback) =>
          callback(null, chosen.address, chosen.family),
      },
      (response) => {
        const chunks: Buffer[] = []
        let length = 0
        response.on('data', (chunk: Buffer) => {
          length += chunk.length
          if (length > maxBytes) {
            request.destroy(
              new MetadataFetchError(
                'oversized',
                `response exceeds ${maxBytes} bytes`
              )
            )
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            bytes: Buffer.concat(chunks),
          })
        )
      }
    )
    request.setTimeout(ERC8004_METADATA_LIMITS.timeoutMs, () =>
      request.destroy(
        new MetadataFetchError('unavailable', 'request timed out')
      )
    )
    request.on('error', reject)
    request.end()
  })

const requestPublic = async (
  input: URL,
  resolver: DnsResolver,
  method: 'GET' | 'HEAD' = 'GET',
  maxBytes = ERC8004_METADATA_LIMITS.maxBytes
): Promise<RawResponse> => {
  let url = input
  for (let redirects = 0; ; redirects++) {
    const addresses = await resolvePublicHost(url, resolver)
    const response = await requestOnce(url, addresses, method, maxBytes)
    if (response.status < 300 || response.status >= 400) {
      return { ...response, finalUrl: url.toString() }
    }
    const location = response.headers.location
    if (!location) {
      throw new MetadataFetchError(
        'unavailable',
        'redirect has no Location header'
      )
    }
    if (redirects >= ERC8004_METADATA_LIMITS.maxRedirects) {
      throw new MetadataFetchError('blocked', 'redirect limit exceeded')
    }
    url = new URL(location, url)
    // The next loop resolves and validates the redirect destination independently.
  }
}

const cleanText = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== 'string') return null
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maxLength)
}

const cleanPresentationUri = (value: unknown): string | null => {
  const text = cleanText(value, 2_048)
  if (!text) return null
  try {
    const url = new URL(text)
    if (url.protocol === 'https:' && !url.username && !url.password) return text
    if (
      url.protocol === 'ipfs:' &&
      /^ipfs:\/\/[a-zA-Z0-9]+(?:\/.*)?$/.test(text)
    )
      return text
  } catch {
    return null
  }
  return null
}

const sanitizeRegistration = (
  input: unknown,
  chainId: number,
  registry: string,
  agentId: bigint
): SanitizedRegistration => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MetadataFetchError(
      'invalid',
      'registration document must be an object'
    )
  }
  const raw = input as Record<string, unknown>
  if (raw.type !== ERC8004_REGISTRATION_TYPE) {
    throw new MetadataFetchError('invalid', 'unsupported registration type')
  }

  const name = cleanText(raw.name, 160)
  const description = cleanText(raw.description, 4_096)
  const image = cleanPresentationUri(raw.image)
  if (!name || description === null || !Array.isArray(raw.services)) {
    throw new MetadataFetchError(
      'invalid',
      'required presentation fields are missing'
    )
  }
  if (typeof raw.x402Support !== 'boolean' || typeof raw.active !== 'boolean') {
    throw new MetadataFetchError(
      'invalid',
      'x402Support and active must be booleans'
    )
  }
  if (!Array.isArray(raw.registrations)) {
    throw new MetadataFetchError('invalid', 'registrations must be an array')
  }

  const services = raw.services
    .slice(0, ERC8004_METADATA_LIMITS.maxServices)
    .flatMap((service) => {
      if (!service || typeof service !== 'object' || Array.isArray(service))
        return []
      const item = service as Record<string, unknown>
      const serviceName = cleanText(item.name, 80)
      const endpoint = cleanText(item.endpoint, 2_048)
      const version = cleanText(item.version, 80)
      if (!serviceName || !endpoint) return []
      return [{ name: serviceName, endpoint, ...(version ? { version } : {}) }]
    })

  const registrations = raw.registrations
    .slice(0, ERC8004_METADATA_LIMITS.maxRegistrations)
    .flatMap((registration) => {
      if (
        !registration ||
        typeof registration !== 'object' ||
        Array.isArray(registration)
      ) {
        return []
      }
      const item = registration as Record<string, unknown>
      const registryValue = cleanText(item.agentRegistry, 256)
      const idValue =
        typeof item.agentId === 'number' && Number.isSafeInteger(item.agentId)
          ? String(item.agentId)
          : cleanText(item.agentId, 80)
      if (!registryValue || !idValue || !/^\d+$/.test(idValue)) return []
      return [
        { agentId: BigInt(idValue).toString(), agentRegistry: registryValue },
      ]
    })

  const expectedRegistry = erc8004RegistryKey(chainId, registry)
  if (
    !registrations.some(
      (registration) =>
        registration.agentId === agentId.toString() &&
        registration.agentRegistry.toLowerCase() === expectedRegistry
    )
  ) {
    throw new MetadataFetchError(
      'invalid',
      'registration backreference does not match the agent'
    )
  }

  const supportedTrust = Array.isArray(raw.supportedTrust)
    ? raw.supportedTrust
        .slice(0, 32)
        .map((value) => cleanText(value, 80))
        .filter((value): value is string => Boolean(value))
    : []

  return {
    type: ERC8004_REGISTRATION_TYPE,
    name,
    description,
    image,
    services,
    x402Support: raw.x402Support,
    active: raw.active,
    registrations,
    supportedTrust,
  }
}

const decodeDataUri = (uri: string): Buffer => {
  const prefix = 'data:application/json;base64,'
  if (!uri.startsWith(prefix)) {
    throw new MetadataFetchError(
      'blocked',
      'only base64 application/json data URIs are allowed'
    )
  }
  const encoded = uri.slice(prefix.length)
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded)) {
    throw new MetadataFetchError('invalid', 'data URI is not valid base64')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length > ERC8004_METADATA_LIMITS.maxBytes) {
    throw new MetadataFetchError('oversized', 'data URI exceeds the byte limit')
  }
  return bytes
}

const contentTypeIsJson = (value: string | string[] | undefined) => {
  const type = Array.isArray(value) ? value[0] : value
  if (!type) return false
  const mime = type.split(';', 1)[0]!.trim().toLowerCase()
  return (
    mime === 'application/json' ||
    /^application\/[a-z0-9.+-]+\+json$/.test(mime)
  )
}

const decimalString = (value: unknown): string | null => {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && Number.isSafeInteger(value))
    return value.toString()
  if (typeof value === 'string' && /^-?\d+$/.test(value))
    return BigInt(value).toString()
  return null
}

const sanitizeReputationDocument = (
  input: unknown,
  context: ReputationDocumentContext
): Record<string, unknown> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MetadataFetchError(
      'invalid',
      'descriptor document must be an object'
    )
  }
  const document = input as Record<string, unknown>
  if (context.kind === 'response') return document

  const expectedRegistry = erc8004RegistryKey(
    context.chainId,
    context.identityRegistry
  )
  const expectedReviewer = `eip155:${context.chainId}:${context.reviewer.toLowerCase()}`
  const registry = cleanText(document.agentRegistry, 256)
  const id = decimalString(document.agentId)
  const reviewer = cleanText(document.clientAddress, 256)
  const createdAt = cleanText(document.createdAt, 128)
  const value = decimalString(document.value)
  const valueDecimals = decimalString(document.valueDecimals)
  if (!registry || !id || !reviewer || !createdAt || !value || !valueDecimals) {
    throw new MetadataFetchError(
      'invalid',
      'feedback descriptor is missing a required backreference field'
    )
  }
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new MetadataFetchError(
      'invalid',
      'feedback createdAt is not a timestamp'
    )
  }
  if (
    registry.toLowerCase() !== expectedRegistry ||
    id !== context.agentId.toString() ||
    reviewer.toLowerCase() !== expectedReviewer ||
    value !== context.value.toString() ||
    valueDecimals !== context.valueDecimals.toString()
  ) {
    throw new MetadataFetchError(
      'invalid',
      'feedback descriptor backreference does not match the on-chain event'
    )
  }
  const optionalMatches: Array<[string, string]> = [
    ['tag1', context.tag],
    ['tag2', context.unit],
    ['endpoint', context.endpoint],
  ]
  for (const [field, expected] of optionalMatches) {
    if (field in document && document[field] !== expected) {
      throw new MetadataFetchError(
        'invalid',
        `feedback descriptor ${field} does not match the on-chain event`
      )
    }
  }
  return document
}

/**
 * Fetch a feedback/response descriptor through the same SSRF-safe boundary as registrations.
 * Feedback documents must bind back to every required on-chain field; response documents have no
 * normative ERC-8004 schema, so their exact bytes/hash and JSON object are preserved without
 * granting them semantic authority.
 */
export const fetchReputationDocument = async ({
  uri,
  expectedHash,
  context,
  ipfsGateway = process.env.ERC8004_IPFS_GATEWAY ?? 'https://ipfs.io/ipfs/',
  resolver = defaultResolver,
}: {
  uri: string
  expectedHash: Hex
  context: ReputationDocumentContext
  ipfsGateway?: string
  resolver?: DnsResolver
}): Promise<ReputationDocumentFetchResult> => {
  const fetchedAt = BigInt(Math.floor(Date.now() / 1_000))
  const mutable = uri.startsWith('https://')
  let finalUri: string | null = null
  let contentType: string | null = null
  let httpStatus: number | null = null
  let bytes: Buffer | null = null
  let contentHash: Hex | null = null

  try {
    if (!uri) throw new MetadataFetchError('blocked', 'descriptor URI is empty')
    if (uri.startsWith('data:')) {
      bytes = decodeDataUri(uri)
      finalUri = uri
      contentType = 'application/json'
    } else {
      let url: URL
      if (uri.startsWith('ipfs://')) {
        const path = uri.slice('ipfs://'.length)
        if (
          !/^[a-zA-Z0-9]+(?:\/[a-zA-Z0-9._~!$&'()*+,;=:@%/-]*)?$/.test(path)
        ) {
          throw new MetadataFetchError('blocked', 'invalid IPFS URI')
        }
        if (
          path
            .split('/')
            .slice(1)
            .some((segment) => {
              try {
                const decoded = decodeURIComponent(segment)
                return decoded === '.' || decoded === '..'
              } catch {
                return true
              }
            })
        ) {
          throw new MetadataFetchError(
            'blocked',
            'IPFS path traversal is not allowed'
          )
        }
        url = new URL(
          path,
          ipfsGateway.endsWith('/') ? ipfsGateway : `${ipfsGateway}/`
        )
      } else {
        url = new URL(uri)
      }
      const response = await requestPublic(url, resolver)
      finalUri = response.finalUrl
      httpStatus = response.status
      contentType = Array.isArray(response.headers['content-type'])
        ? (response.headers['content-type'][0] ?? null)
        : (response.headers['content-type'] ?? null)
      if (response.status < 200 || response.status >= 300) {
        throw new MetadataFetchError('unavailable', `HTTP ${response.status}`)
      }
      if (!contentTypeIsJson(response.headers['content-type'])) {
        throw new MetadataFetchError(
          'invalid',
          'response Content-Type is not JSON'
        )
      }
      bytes = response.bytes
    }

    contentHash = keccak256(toHex(bytes))
    if (
      expectedHash !== zeroHash &&
      contentHash.toLowerCase() !== expectedHash.toLowerCase()
    ) {
      throw new MetadataFetchError(
        'invalid',
        'on-chain content hash does not match fetched bytes',
        { contentHash, byteLength: bytes.length }
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new MetadataFetchError('invalid', 'response is not valid JSON', {
        contentHash,
        byteLength: bytes.length,
      })
    }
    const document = sanitizeReputationDocument(parsed, context)
    return {
      status: 'ok',
      uri,
      finalUri,
      contentHash,
      hashStatus: expectedHash === zeroHash ? 'omitted' : 'match',
      contentType,
      byteLength: bytes.length,
      httpStatus,
      mutable,
      fetchedAt,
      error: null,
      document,
    }
  } catch (error) {
    const typed =
      error instanceof MetadataFetchError
        ? error
        : new MetadataFetchError(
            'unavailable',
            error instanceof Error ? error.message : String(error)
          )
    const mismatch = /content hash does not match/.test(typed.message)
    return {
      status: typed.status,
      uri,
      finalUri: typed.details.finalUri ?? finalUri,
      contentHash: typed.details.contentHash ?? contentHash,
      hashStatus: mismatch
        ? 'mismatch'
        : expectedHash === zeroHash
          ? 'omitted'
          : 'unverified',
      contentType: typed.details.contentType ?? contentType,
      byteLength: typed.details.byteLength ?? bytes?.length ?? null,
      httpStatus: typed.details.httpStatus ?? httpStatus,
      mutable,
      fetchedAt,
      error: typed.message,
      document: null,
    }
  }
}

export const observeEndpoint = async (
  serviceName: string,
  endpoint: string,
  resolver: DnsResolver = defaultResolver
): Promise<EndpointObservation> => {
  const checkedAt = BigInt(Math.floor(Date.now() / 1_000))
  const started = Date.now()
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return {
      serviceName,
      endpoint,
      status: 'unsupported_scheme',
      httpStatus: null,
      checkedAt,
      latencyMs: Date.now() - started,
      error: 'endpoint is not an absolute URL',
    }
  }
  if (url.protocol !== 'https:') {
    return {
      serviceName,
      endpoint,
      status: 'unsupported_scheme',
      httpStatus: null,
      checkedAt,
      latencyMs: Date.now() - started,
      error: 'only HTTPS endpoints are checked',
    }
  }
  try {
    const response = await requestPublic(url, resolver, 'HEAD', 0)
    return {
      serviceName,
      endpoint,
      status:
        response.status >= 200 && response.status < 500
          ? 'reachable'
          : 'unreachable',
      httpStatus: response.status,
      checkedAt,
      latencyMs: Date.now() - started,
      error: null,
    }
  } catch (error) {
    const blocked =
      error instanceof MetadataFetchError && error.status === 'blocked'
    return {
      serviceName,
      endpoint,
      status: blocked ? 'blocked' : 'unreachable',
      httpStatus: null,
      checkedAt,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const mapBounded = async <T, R>(
  values: T[],
  concurrency: number,
  fn: (value: T) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(values.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = cursor++
        if (index >= values.length) return
        results[index] = await fn(values[index]!)
      }
    })
  )
  return results
}

export const fetchRegistrationDocument = async ({
  uri,
  chainId,
  registry,
  agentId,
  ipfsGateway = process.env.ERC8004_IPFS_GATEWAY ?? 'https://ipfs.io/ipfs/',
  resolver = defaultResolver,
  checkEndpoints = true,
}: {
  uri: string
  chainId: number
  registry: string
  agentId: bigint
  ipfsGateway?: string
  resolver?: DnsResolver
  checkEndpoints?: boolean
}): Promise<RegistrationFetchResult> => {
  const fetchedAt = BigInt(Math.floor(Date.now() / 1_000))
  const mutable = uri.startsWith('https://')
  let finalUri: string | null = null
  let contentType: string | null = null
  let httpStatus: number | null = null
  let bytes: Buffer | null = null

  try {
    if (uri.startsWith('data:')) {
      bytes = decodeDataUri(uri)
      finalUri = uri
      contentType = 'application/json'
      httpStatus = null
    } else {
      let url: URL
      if (uri.startsWith('ipfs://')) {
        const path = uri.slice('ipfs://'.length)
        if (
          !/^[a-zA-Z0-9]+(?:\/[a-zA-Z0-9._~!$&'()*+,;=:@%/-]*)?$/.test(path)
        ) {
          throw new MetadataFetchError('blocked', 'invalid IPFS URI')
        }
        if (
          path
            .split('/')
            .slice(1)
            .some((segment) => {
              try {
                const decoded = decodeURIComponent(segment)
                return decoded === '.' || decoded === '..'
              } catch {
                return true
              }
            })
        ) {
          throw new MetadataFetchError(
            'blocked',
            'IPFS path traversal is not allowed'
          )
        }
        url = new URL(
          path,
          ipfsGateway.endsWith('/') ? ipfsGateway : `${ipfsGateway}/`
        )
      } else {
        url = new URL(uri)
      }
      const response = await requestPublic(url, resolver)
      finalUri = response.finalUrl
      httpStatus = response.status
      contentType = Array.isArray(response.headers['content-type'])
        ? (response.headers['content-type'][0] ?? null)
        : (response.headers['content-type'] ?? null)
      if (response.status < 200 || response.status >= 300) {
        throw new MetadataFetchError('unavailable', `HTTP ${response.status}`, {
          finalUri,
          httpStatus,
          contentType,
        })
      }
      if (!contentTypeIsJson(response.headers['content-type'])) {
        throw new MetadataFetchError(
          'invalid',
          'response Content-Type is not JSON',
          {
            finalUri,
            httpStatus,
            contentType,
          }
        )
      }
      bytes = response.bytes
    }

    const contentHash = `0x${createHash('sha256').update(bytes).digest('hex')}`
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new MetadataFetchError('invalid', 'response is not valid JSON', {
        finalUri,
        contentHash,
        contentType,
        byteLength: bytes.length,
        httpStatus,
      })
    }
    const document = sanitizeRegistration(parsed, chainId, registry, agentId)
    const endpointObservations = checkEndpoints
      ? await mapBounded(
          document.services,
          ERC8004_METADATA_LIMITS.endpointConcurrency,
          (service) => observeEndpoint(service.name, service.endpoint, resolver)
        )
      : []
    return {
      status: 'ok',
      uri,
      finalUri,
      contentHash,
      contentType,
      byteLength: bytes.length,
      httpStatus,
      mutable,
      fetchedAt,
      error: null,
      document,
      endpointObservations,
    }
  } catch (error) {
    const typed =
      error instanceof MetadataFetchError
        ? error
        : new MetadataFetchError(
            'unavailable',
            error instanceof Error ? error.message : String(error)
          )
    return {
      status: typed.status,
      uri,
      finalUri: typed.details.finalUri ?? finalUri,
      contentHash: typed.details.contentHash ?? null,
      contentType: typed.details.contentType ?? contentType,
      byteLength: typed.details.byteLength ?? bytes?.length ?? null,
      httpStatus: typed.details.httpStatus ?? httpStatus,
      mutable,
      fetchedAt,
      error: typed.message,
      document: null,
      endpointObservations: [],
    }
  }
}
