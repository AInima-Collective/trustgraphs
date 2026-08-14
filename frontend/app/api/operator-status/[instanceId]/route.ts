import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { NextResponse } from 'next/server'

import { CHAIN } from '@/lib/config'

export const dynamic = 'force-dynamic'

const MAX_STATUS_BYTES = 256 * 1024
const INSTANCE_ID = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

type JsonRecord = Record<string, unknown>

const record = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null

const safeInteger = (value: unknown): number | null => {
  const number = finiteNumber(value)
  return number !== null && Number.isSafeInteger(number) ? number : null
}

const boolean = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null

const address = (value: unknown): string | null =>
  typeof value === 'string' && ADDRESS.test(value) ? value : null

const text = (value: unknown, max = 80): string | null =>
  typeof value === 'string' && value.length <= max ? value : null

/** Read a remote heartbeat without trusting Content-Length or buffering an unbounded body. */
const readLimitedResponse = async (
  response: Response
): Promise<string | null> => {
  const reader = response.body?.getReader()
  if (!reader) return null

  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_STATUS_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(decoder.decode(value, { stream: true }))
  }
  chunks.push(decoder.decode())
  return chunks.join('')
}

const readStatusSource = async (): Promise<unknown | null> => {
  const configuredUrl = process.env.OPERATOR_STATUS_URL
  if (configuredUrl) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2_000)
    try {
      const response = await fetch(configuredUrl, {
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!response.ok) return null
      const declared = Number(response.headers.get('content-length') || 0)
      if (declared > MAX_STATUS_BYTES) return null
      const body = await readLimitedResponse(response)
      if (body === null) return null
      return JSON.parse(body) as unknown
    } catch (error) {
      console.warn('[operator-status] configured URL is unavailable:', error)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  const configuredPath = process.env.OPERATOR_STATUS_PATH
  const candidates = configuredPath
    ? [path.resolve(configuredPath)]
    : CHAIN === 'local'
      ? [
          path.resolve(process.cwd(), '.demo/status.json'),
          path.resolve(process.cwd(), '..', '.demo/status.json'),
        ]
      : []

  for (const candidate of candidates) {
    try {
      const metadata = await stat(candidate)
      if (!metadata.isFile() || metadata.size > MAX_STATUS_BYTES) return null
      const body = await readFile(candidate)
      if (body.byteLength > MAX_STATUS_BYTES) return null
      return JSON.parse(body.toString('utf8')) as unknown
    } catch {
      // A missing heartbeat is a normal deployment state; try the next local candidate.
    }
  }
  return null
}

const sanitizeAction = (value: unknown) => {
  const input = record(value)
  if (!input) return null

  const action = text(input.action, 24)
  if (
    !action ||
    ![
      'idle',
      'trigger',
      'await_finality',
      'prove',
      'publish',
      'submit',
      'hold',
      'skip',
    ].includes(action)
  ) {
    return null
  }

  const reasonKey =
    action === 'idle'
      ? 'idle'
      : action === 'hold'
        ? 'hold'
        : action === 'skip'
          ? 'skip'
          : null
  const reason = reasonKey ? text(input[reasonKey], 48) : null

  return {
    action,
    reason,
    checkpointId: safeInteger(input.checkpoint_id),
    confirmations: safeInteger(input.confirmations),
    requiredConfirmations: safeInteger(input.required),
    boundaryBlock: safeInteger(input.boundary),
    attempts: safeInteger(input.attempts),
    retryAt: safeInteger(input.retry_at),
  }
}

const sanitizeSettings = (value: unknown) => {
  const input = record(value)
  if (!input) return null

  return {
    paidEnabled: boolean(input.paid_enabled),
    paidVault: address(input.paid_vault),
    paidRecipient: address(input.paid_recipient),
    tickSeconds: safeInteger(input.tick_seconds),
    subsidyMinBlocks: safeInteger(input.subsidy_min_blocks),
    maxConcurrent: safeInteger(input.max_concurrent),
    maxPerInstance: safeInteger(input.max_per_instance),
    maxBasefeeGwei: safeInteger(input.max_basefee_gwei),
    replacementAfterSeconds: safeInteger(input.replacement_after_s),
    simulateBeforeSend: boolean(input.simulate_before_send),
    submitFailureThreshold: safeInteger(input.submit_failure_threshold),
    confirmations: safeInteger(input.confirmations),
    tracksBlockHash: boolean(input.track_block_hash),
    proverBackend: text(input.prover_backend, 24),
    groth16: boolean(input.groth16),
    proofTimeoutSeconds: safeInteger(input.proof_timeout_s),
    perInstanceUsdPerDay: safeInteger(input.per_instance_usd_per_day),
    globalUsdPerDay: safeInteger(input.global_usd_per_day),
    budgetWindowSeconds: safeInteger(input.budget_window_seconds),
    publishesScores: boolean(input.publishes_scores),
    verifiesScoreReadback: boolean(input.verifies_score_readback),
    publicationTargetCount: safeInteger(input.publication_target_count),
    publicationMinimum: safeInteger(input.publication_min_success),
    publicationRetrySeconds: safeInteger(input.publication_retry_seconds),
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ instanceId: string }> }
) {
  const { instanceId } = await params
  if (!INSTANCE_ID.test(instanceId)) {
    return NextResponse.json({ error: 'Invalid instance id' }, { status: 400 })
  }

  const raw = record(await readStatusSource())
  if (!raw) {
    return NextResponse.json(
      { available: false },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  }

  const instances = Array.isArray(raw.instances) ? raw.instances : []
  const wanted = instances
    .map(record)
    .find(
      (entry) =>
        text(entry?.instance_id, 66)?.toLowerCase() === instanceId.toLowerCase()
    )

  if (!wanted) {
    return NextResponse.json(
      {
        available: true,
        chainId: safeInteger(raw.chain_id),
        headBlock: safeInteger(raw.head_block),
        tickAt: safeInteger(raw.tick_at),
        instance: null,
        settings: sanitizeSettings(raw.settings),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  }

  const snapshot = address(wanted.snapshot)
  const program = text(wanted.program, 32)
  const name = text(wanted.name, 128)

  return NextResponse.json(
    {
      available: true,
      chainId: safeInteger(raw.chain_id),
      headBlock: safeInteger(raw.head_block),
      tickAt: safeInteger(raw.tick_at),
      instance: {
        name,
        program,
        snapshot,
        curated: boolean(wanted.curated),
        action: sanitizeAction(wanted.action),
        blocksSinceRoot: safeInteger(wanted.blocks_since_root),
      },
      settings: sanitizeSettings(raw.settings),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
