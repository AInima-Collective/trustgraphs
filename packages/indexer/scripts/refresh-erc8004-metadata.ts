import { createHash } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'

import { type Hex } from 'viem'

import {
  erc8004EndpointObservation,
  erc8004RegistrationDocument,
  erc8004ReputationDocument,
} from '../offchain.schema'
import { offchainDb, offchainPool } from '../src/api/db'
import {
  type ReputationDocumentContext,
  fetchRegistrationDocument,
  fetchReputationDocument,
} from '../src/erc8004-metadata'

type Task = {
  agentKey: string
  chainId: number
  registry: string
  agentId: string
  uri: string
  sourceBlock: string
  sourceLogIndex: number
}

type ReputationTask = {
  subjectId: string
  feedbackId: string
  kind: 'feedback' | 'response'
  uri: string
  expectedHash: Hex
  sourceBlock: string
  sourceTransactionIndex: number
  sourceLogIndex: number
  context:
    | {
        kind: 'feedback'
        chainId: number
        identityRegistry: string
        agentId: string
        reviewer: Hex
        value: string
        valueDecimals: number
        tag: string
        unit: string
        endpoint: string
      }
    | { kind: 'response' }
}

const registrationTasksUrl =
  process.env.ERC8004_METADATA_TASKS_URL ??
  'http://127.0.0.1:42069/erc8004/metadata-tasks'
const reputationTasksUrl =
  process.env.ERC8004_FEEDBACK_METADATA_TASKS_URL ??
  'http://127.0.0.1:42069/erc8004/feedback-metadata-tasks'
const limit = Math.max(
  1,
  Math.min(500, Number(process.env.ERC8004_METADATA_BATCH_SIZE ?? 100))
)
const concurrency = Math.max(
  1,
  Math.min(16, Number(process.env.ERC8004_METADATA_CONCURRENCY ?? 4))
)
const watch = process.argv.includes('--watch')
const intervalMs = Math.max(
  300_000,
  Number(process.env.ERC8004_METADATA_INTERVAL_MS ?? 3_600_000)
)

const observationId = (...parts: string[]) =>
  createHash('sha256').update(parts.join('\0')).digest('hex')

const fetchTasks = async <T>(apiUrl: string): Promise<T[]> => {
  const url = new URL(apiUrl)
  url.searchParams.set('limit', String(limit))
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok)
    throw new Error(`metadata task API returned HTTP ${response.status}`)
  const body = (await response.json()) as { tasks?: T[] }
  return body.tasks ?? []
}

const reputationContext = (
  context: ReputationTask['context']
): ReputationDocumentContext =>
  context.kind === 'response'
    ? context
    : {
        ...context,
        agentId: BigInt(context.agentId),
        value: BigInt(context.value),
      }

const processTask = async (task: Task) => {
  const result = await fetchRegistrationDocument({
    uri: task.uri,
    chainId: task.chainId,
    registry: task.registry,
    agentId: BigInt(task.agentId),
  })
  const documentId = observationId(
    task.agentKey,
    task.uri,
    result.fetchedAt.toString(),
    result.contentHash ?? result.status
  )
  await offchainDb
    .insert(erc8004RegistrationDocument)
    .values({
      id: documentId,
      agentKey: task.agentKey,
      uri: task.uri,
      finalUri: result.finalUri,
      contentHash: result.contentHash,
      schemaVersion: result.document?.type ?? null,
      parsedJson: result.document as unknown as Record<string, unknown> | null,
      fetchedAt: result.fetchedAt,
      fetchStatus: result.status,
      error: result.error,
      httpStatus: result.httpStatus,
      contentType: result.contentType,
      byteLength: result.byteLength,
      mutable: result.mutable,
      sourceBlock: BigInt(task.sourceBlock),
      sourceLogIndex: task.sourceLogIndex,
    })
    .onConflictDoNothing()
  for (const endpoint of result.endpointObservations) {
    await offchainDb
      .insert(erc8004EndpointObservation)
      .values({
        id: observationId(documentId, endpoint.serviceName, endpoint.endpoint),
        documentId,
        agentKey: task.agentKey,
        serviceName: endpoint.serviceName,
        endpoint: endpoint.endpoint,
        status: endpoint.status,
        httpStatus: endpoint.httpStatus,
        checkedAt: endpoint.checkedAt,
        latencyMs: endpoint.latencyMs,
        error: endpoint.error,
      })
      .onConflictDoNothing()
  }
  return result.status
}

const processReputationTask = async (task: ReputationTask) => {
  const result = await fetchReputationDocument({
    uri: task.uri,
    expectedHash: task.expectedHash,
    context: reputationContext(task.context),
  })
  const documentId = observationId(
    task.subjectId,
    task.uri,
    result.fetchedAt.toString(),
    result.contentHash ?? result.status
  )
  await offchainDb
    .insert(erc8004ReputationDocument)
    .values({
      id: documentId,
      subjectId: task.subjectId,
      feedbackId: task.feedbackId,
      kind: task.kind,
      uri: task.uri,
      finalUri: result.finalUri,
      expectedHash: task.expectedHash,
      contentHash: result.contentHash,
      hashStatus: result.hashStatus,
      parsedJson: result.document,
      fetchedAt: result.fetchedAt,
      fetchStatus: result.status,
      error: result.error,
      httpStatus: result.httpStatus,
      contentType: result.contentType,
      byteLength: result.byteLength,
      mutable: result.mutable,
      sourceBlock: BigInt(task.sourceBlock),
      sourceTransactionIndex: task.sourceTransactionIndex,
      sourceLogIndex: task.sourceLogIndex,
    })
    .onConflictDoNothing()
  return result.status
}

const mapBounded = async <T>(
  values: T[],
  fn: (value: T) => Promise<unknown>
) => {
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = cursor++
        if (index >= values.length) return
        await fn(values[index]!)
      }
    })
  )
}

const run = async () => {
  const [registrationTasks, reputationTasks] = await Promise.all([
    fetchTasks<Task>(registrationTasksUrl),
    fetchTasks<ReputationTask>(reputationTasksUrl),
  ])
  const tasks = [
    ...registrationTasks.map((task) => ({
      type: 'registration' as const,
      task,
    })),
    ...reputationTasks.map((task) => ({ type: 'reputation' as const, task })),
  ]
  const counts = new Map<string, number>()
  await mapBounded(tasks, async (work) => {
    const status =
      work.type === 'registration'
        ? await processTask(work.task)
        : await processReputationTask(work.task)
    counts.set(status, (counts.get(status) ?? 0) + 1)
  })
  console.log(
    `erc8004 metadata: processed ${tasks.length} task(s) ${JSON.stringify(Object.fromEntries(counts))}`
  )
}

try {
  do {
    await run()
    if (watch) await wait(intervalMs)
  } while (watch)
} finally {
  await offchainPool.end()
}
