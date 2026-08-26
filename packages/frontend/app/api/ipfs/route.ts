import { NextRequest, NextResponse } from 'next/server'

import { CHAIN } from '@/lib/config'

/**
 * Pin a network's presentation blob to IPFS.
 *
 * The sibling `[cid]/route.ts` is the read half of this pair; this is the write half. It follows
 * the same `pinApi` shape `contracts/deploy/env.ts:uploadToIpfs()` uses: a local kubo `/api/v0/add?pin=true`
 * in dev (returns `{ Hash }`), Pinata's uploads API in prod (bearer token, returns `{ data: { cid } }`).
 *
 * This is a public, unauthenticated write path, so it is deliberately narrow: it accepts ONLY the
 * five-field metadata object the instance factory's `metadataURI` points at, caps every field and
 * the request as a whole, and pins a blob it re-serializes itself rather than the caller's bytes.
 * Nothing else can be pushed through it.
 */

/** Hard cap on the raw request body. The validated shape is far smaller; this stops the read. */
const MAX_REQUEST_BYTES = 32 * 1024
/** Cap on what we will actually pin, after re-serializing the validated fields. */
const MAX_PINNED_BYTES = 16 * 1024
const QUOTA_WINDOW_MS = 60 * 60 * 1_000

const positiveQuota = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new Error(`${name} must be an integer between 1 and 100000`)
  }
  return value
}

type PinQuotaState = {
  windowStartedAt: number
  globalCount: number
  perIp: Map<string, number>
  alerted: boolean
}

const quotaGlobal = globalThis as typeof globalThis & {
  __trustgraphsPinQuota?: PinQuotaState
}

const quotaState = (): PinQuotaState => {
  const now = Date.now()
  const current = quotaGlobal.__trustgraphsPinQuota
  if (!current || now - current.windowStartedAt >= QUOTA_WINDOW_MS) {
    quotaGlobal.__trustgraphsPinQuota = {
      windowStartedAt: now,
      globalCount: 0,
      perIp: new Map(),
      alerted: false,
    }
  }
  return quotaGlobal.__trustgraphsPinQuota!
}

/** Per-field caps. `name` matches the factory's own 64-byte bound on the on-chain name. */
const FIELD_LIMITS = {
  name: 64,
  description: 2_000,
  criteria: 8_000,
  image: 512,
  applicationUrl: 512,
} as const

type MetadataField = keyof typeof FIELD_LIMITS
const FIELDS = Object.keys(FIELD_LIMITS) as MetadataField[]

/** Where to pin. Defaults mirror `contracts/deploy/env.ts`; override per environment. */
const pinApi = () =>
  process.env.IPFS_PIN_API ||
  (CHAIN === 'local'
    ? 'http://127.0.0.1:5001/api/v0/add?pin=true'
    : 'https://uploads.pinata.cloud/v3/files')

const pinApiKey = () => process.env.IPFS_PIN_API_KEY

const publicPinConfigurationError = (): string | undefined => {
  if (CHAIN === 'local') return undefined
  if (!pinApiKey()?.trim()) return 'IPFS_PIN_API_KEY is not configured'
  try {
    const url = new URL(pinApi())
    if (url.protocol !== 'https:') {
      return 'IPFS_PIN_API must use HTTPS on a public chain'
    }
  } catch {
    return 'IPFS_PIN_API is not a valid absolute URL'
  }
  return undefined
}

const byteLength = (value: string) => new TextEncoder().encode(value).length

const isSafeUrl = (value: string) =>
  value.startsWith('https://') ||
  value.startsWith('http://') ||
  value.startsWith('ipfs://')

const bad = (error: string) => NextResponse.json({ error }, { status: 400 })

const requestIp = (request: NextRequest): string =>
  request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
  request.headers.get('x-real-ip')?.trim() ||
  'unknown'

const allowedOrigins = (request: NextRequest): Set<string> => {
  const configured = [
    process.env.FRONTEND_URL,
    ...(process.env.IPFS_PIN_ALLOWED_ORIGINS || '').split(','),
  ]
    .map((value) => value?.trim().replace(/\/$/, ''))
    .filter((value): value is string => Boolean(value))
  return new Set([request.nextUrl.origin, ...configured])
}

const originAllowed = (request: NextRequest): boolean => {
  const origin = request.headers.get('origin')?.replace(/\/$/, '')
  if (!origin) return process.env.NODE_ENV !== 'production'
  return allowedOrigins(request).has(origin)
}

const quotaExceeded = (retryAfter: number) =>
  NextResponse.json(
    { error: 'IPFS pin quota exceeded; try again later' },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } }
  )

const alertOnQuota = async (state: PinQuotaState, globalQuota: number) => {
  if (state.alerted || state.globalCount < Math.ceil(globalQuota * 0.8)) {
    return
  }
  state.alerted = true
  console.warn(
    `IPFS pin quota is at ${state.globalCount}/${globalQuota} in the current window`
  )
  const webhook = process.env.IPFS_PIN_QUOTA_ALERT_WEBHOOK
  if (!webhook) return
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'ipfs_pin_quota_warning',
        used: state.globalCount,
        limit: globalQuota,
        windowStartedAt: new Date(state.windowStartedAt).toISOString(),
      }),
      signal: AbortSignal.timeout(3_000),
    })
  } catch (error) {
    console.error('Could not deliver IPFS pin quota alert:', error)
  }
}

export async function POST(request: NextRequest) {
  let perIpQuota: number
  let globalQuota: number
  try {
    perIpQuota = positiveQuota('IPFS_PIN_PER_IP_HOURLY_QUOTA', 5)
    globalQuota = positiveQuota('IPFS_PIN_GLOBAL_HOURLY_QUOTA', 100)
  } catch (error) {
    console.error('IPFS pin quota configuration is invalid:', error)
    return NextResponse.json(
      { error: 'IPFS pin service is not configured' },
      { status: 503 }
    )
  }

  const configurationError = publicPinConfigurationError()
  if (configurationError) {
    console.error(`IPFS pin service is unavailable: ${configurationError}`)
    return NextResponse.json(
      { error: 'IPFS pin service is not configured' },
      { status: 503 }
    )
  }

  if (!originAllowed(request)) {
    return NextResponse.json(
      { error: 'Origin is not allowed' },
      { status: 403 }
    )
  }

  const quota = quotaState()
  const ip = requestIp(request)
  const ipCount = quota.perIp.get(ip) || 0
  const retryAfter = Math.max(
    1,
    Math.ceil((quota.windowStartedAt + QUOTA_WINDOW_MS - Date.now()) / 1_000)
  )
  if (quota.globalCount >= globalQuota || ipCount >= perIpQuota) {
    return quotaExceeded(retryAfter)
  }
  // Count attempts before any await so concurrent requests cannot all pass the same quota check.
  // Invalid bodies and upstream failures count too: both consume public route capacity.
  quota.globalCount += 1
  quota.perIp.set(ip, ipCount + 1)
  await alertOnQuota(quota, globalQuota)

  const declaredLength = Number(request.headers.get('content-length') || 0)
  if (declaredLength > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'Body too large' }, { status: 413 })
  }

  const contentType = request.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    return bad('Expected a JSON body')
  }

  let raw: string
  try {
    raw = await request.text()
  } catch {
    return bad('Could not read the request body')
  }
  if (byteLength(raw) > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: 'Body too large' }, { status: 413 })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return bad('Body was not valid JSON')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return bad('Body must be a JSON object')
  }

  const input = parsed as Record<string, unknown>

  // Reject anything outside the known shape rather than silently dropping it, so a caller can
  // never believe it pinned something it did not.
  for (const key of Object.keys(input)) {
    if (!FIELDS.includes(key as MetadataField)) {
      return bad(`Unexpected field: ${key}`)
    }
  }

  const metadata: Record<MetadataField, string> = {
    name: '',
    description: '',
    criteria: '',
    image: '',
    applicationUrl: '',
  }

  for (const field of FIELDS) {
    const value = input[field]
    if (value === undefined || value === null) {
      continue
    }
    if (typeof value !== 'string') {
      return bad(`${field} must be a string`)
    }
    if (byteLength(value) > FIELD_LIMITS[field]) {
      return bad(`${field} is longer than ${FIELD_LIMITS[field]} bytes`)
    }
    metadata[field] = value
  }

  if (!metadata.name.trim()) {
    return bad('name is required')
  }
  for (const field of ['image', 'applicationUrl'] as const) {
    if (metadata[field] && !isSafeUrl(metadata[field])) {
      return bad(`${field} must be an http(s) or ipfs URL`)
    }
  }

  // Pin OUR serialization of the validated fields, never the caller's bytes.
  const blob = JSON.stringify(metadata)
  if (byteLength(blob) > MAX_PINNED_BYTES) {
    return bad('Metadata is too large')
  }

  const apiKey = pinApiKey()
  const formData = new FormData()
  formData.append(
    'file',
    new Blob([blob], { type: 'application/json' }),
    'trustgraph-network.json'
  )
  // Pinata's uploads API wants these two; kubo ignores unknown parts.
  if (apiKey) {
    formData.append('network', 'public')
    formData.append('name', `trustgraph-network-${Date.now()}.json`)
  }

  try {
    const response = await fetch(pinApi(), {
      method: 'POST',
      body: formData,
      ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      console.error(
        `IPFS pin failed: ${response.status} ${response.statusText}. Body: ${body}`
      )
      return NextResponse.json(
        { error: `Failed to pin to IPFS: ${response.status}` },
        { status: 502 }
      )
    }

    // kubo: `{ Name, Hash, Size }`. Pinata v3: `{ data: { cid } }`.
    const result = await response.json()
    const cid: string | undefined = result?.Hash || result?.data?.cid

    if (!cid || typeof cid !== 'string') {
      console.error('IPFS pin returned no CID:', result)
      return NextResponse.json(
        { error: 'IPFS did not return a content id' },
        { status: 502 }
      )
    }

    return NextResponse.json({ cid, uri: `ipfs://${cid}` })
  } catch (error: unknown) {
    console.error('IPFS pin error:', error)
    return NextResponse.json({ error: 'IPFS request failed' }, { status: 500 })
  }
}
