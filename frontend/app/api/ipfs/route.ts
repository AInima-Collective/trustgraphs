import { NextRequest, NextResponse } from 'next/server'

import { CHAIN } from '@/lib/config'

/**
 * Pin a network's presentation blob to IPFS.
 *
 * The sibling `[cid]/route.ts` is the read half of this pair; this is the write half. It follows
 * the same `pinApi` shape `deploy/env.ts:uploadToIpfs()` uses: a local kubo `/api/v0/add?pin=true`
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

/** Where to pin. Defaults mirror `deploy/env.ts`; override per environment. */
const pinApi = () =>
  process.env.IPFS_PIN_API ||
  (CHAIN === 'local'
    ? 'http://127.0.0.1:5001/api/v0/add?pin=true'
    : 'https://uploads.pinata.cloud/v3/files')

const pinApiKey = () => process.env.IPFS_PIN_API_KEY

const byteLength = (value: string) => new TextEncoder().encode(value).length

const isSafeUrl = (value: string) =>
  value.startsWith('https://') ||
  value.startsWith('http://') ||
  value.startsWith('ipfs://')

const bad = (error: string) => NextResponse.json({ error }, { status: 400 })

export async function POST(request: NextRequest) {
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
  } catch (error: any) {
    console.error('IPFS pin error:', error)
    return NextResponse.json(
      { error: `IPFS request failed: ${error.message}` },
      { status: 500 }
    )
  }
}
