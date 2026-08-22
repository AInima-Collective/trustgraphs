import {
  type SQL,
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  or,
} from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from 'ponder:api'
import {
  erc8004Agent,
  erc8004AgentEvent,
  erc8004AgentRelationHistory,
  erc8004AgentUriVersion,
  erc8004Feedback,
  erc8004FeedbackResponse,
  erc8004Registry,
  erc8004RegistryEvent,
  erc8004ReputationRegistry,
} from 'ponder:schema'
import { type Hex, isAddress } from 'viem'

import { offchainDb } from './db'
import {
  erc8004EndpointObservation,
  erc8004RegistrationDocument,
  erc8004ReputationDocument,
} from '../../offchain.schema'
import { erc8004AgentKey, erc8004RegistryKey } from '../erc8004-shared'
import {
  encodeFeedbackCursor,
  parseFeedbackQuery,
} from './erc8004-reputation-api-shared'

const app = new Hono()

const agentSummary = (
  row: typeof erc8004Agent.$inferSelect,
  roles: Array<'owner' | 'verified_wallet'>,
  document?: typeof erc8004RegistrationDocument.$inferSelect
) => ({
  key: row.id,
  namespace: 'eip155' as const,
  chainId: row.chainId,
  registry: row.registry,
  agentId: row.agentId.toString(),
  owner: row.owner,
  agentWallet: row.agentWallet,
  agentURI: row.agentURI,
  roles,
  name:
    document?.fetchStatus === 'ok' &&
    document.parsedJson &&
    typeof document.parsedJson.name === 'string'
      ? document.parsedJson.name
      : null,
  registrationStatus: document?.fetchStatus ?? 'not_fetched',
})

const latestDocumentsFor = async (agentKeys: string[]) => {
  if (agentKeys.length === 0)
    return new Map<string, typeof erc8004RegistrationDocument.$inferSelect>()
  const rows = await offchainDb
    .select()
    .from(erc8004RegistrationDocument)
    .where(inArray(erc8004RegistrationDocument.agentKey, agentKeys))
    .orderBy(desc(erc8004RegistrationDocument.fetchedAt))
  const latest = new Map<string, (typeof rows)[number]>()
  for (const row of rows)
    if (!latest.has(row.agentKey)) latest.set(row.agentKey, row)
  return latest
}

const latestReputationDocumentsFor = async (subjectIds: string[]) => {
  if (subjectIds.length === 0)
    return new Map<string, typeof erc8004ReputationDocument.$inferSelect>()
  const rows = await offchainDb
    .select()
    .from(erc8004ReputationDocument)
    .where(inArray(erc8004ReputationDocument.subjectId, subjectIds))
    .orderBy(desc(erc8004ReputationDocument.fetchedAt))
  const latest = new Map<string, (typeof rows)[number]>()
  for (const row of rows)
    if (!latest.has(row.subjectId)) latest.set(row.subjectId, row)
  return latest
}

const serializeRow = <T extends Record<string, unknown>>(row: T) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? value.toString() : value,
    ])
  )

const documentSummary = (
  document: typeof erc8004ReputationDocument.$inferSelect | undefined
) =>
  document
    ? {
        kind: document.kind,
        uri: document.uri,
        finalUri: document.finalUri,
        expectedHash: document.expectedHash,
        contentHash: document.contentHash,
        hashStatus: document.hashStatus,
        fetchStatus: document.fetchStatus,
        fetchedAt: document.fetchedAt.toString(),
        mutable: document.mutable,
        byteLength: document.byteLength,
        error: document.error,
      }
    : null

/** Stable keyset-paginated raw event API; one feedback query plus bulk response/document queries. */
app.get('/feedback', async (c) => {
  const parsed = parseFeedbackQuery((name) => c.req.query(name))
  if (!parsed.value) return c.json({ error: parsed.error }, 400)
  const query = parsed.value
  const conditions: SQL[] = []
  if (query.agent)
    conditions.push(eq(erc8004Feedback.targetAgentKey, query.agent))
  if (query.reviewer)
    conditions.push(eq(erc8004Feedback.reviewer, query.reviewer as Hex))
  if (query.tag !== null) conditions.push(eq(erc8004Feedback.tag, query.tag))
  if (query.unit !== null) conditions.push(eq(erc8004Feedback.unit, query.unit))
  if (query.revoked !== 'all')
    conditions.push(eq(erc8004Feedback.revoked, query.revoked === 'revoked'))
  if (query.fromBlock !== null)
    conditions.push(gte(erc8004Feedback.blockNumber, query.fromBlock))
  if (query.toBlock !== null)
    conditions.push(lte(erc8004Feedback.blockNumber, query.toBlock))
  if (query.cursor) {
    const blockNumber = BigInt(query.cursor.blockNumber)
    conditions.push(
      or(
        lt(erc8004Feedback.blockNumber, blockNumber),
        and(
          eq(erc8004Feedback.blockNumber, blockNumber),
          lt(erc8004Feedback.transactionIndex, query.cursor.transactionIndex)
        ),
        and(
          eq(erc8004Feedback.blockNumber, blockNumber),
          eq(erc8004Feedback.transactionIndex, query.cursor.transactionIndex),
          lt(erc8004Feedback.logIndex, query.cursor.logIndex)
        ),
        and(
          eq(erc8004Feedback.blockNumber, blockNumber),
          eq(erc8004Feedback.transactionIndex, query.cursor.transactionIndex),
          eq(erc8004Feedback.logIndex, query.cursor.logIndex),
          lt(erc8004Feedback.id, query.cursor.id)
        )
      )!
    )
  }

  const rows = await db
    .select()
    .from(erc8004Feedback)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(
      desc(erc8004Feedback.blockNumber),
      desc(erc8004Feedback.transactionIndex),
      desc(erc8004Feedback.logIndex),
      desc(erc8004Feedback.id)
    )
    .limit(query.limit + 1)
  const hasMore = rows.length > query.limit
  const page = rows.slice(0, query.limit)
  const feedbackIds = page.map((row) => row.id)
  const responses = feedbackIds.length
    ? await db
        .select()
        .from(erc8004FeedbackResponse)
        .where(inArray(erc8004FeedbackResponse.feedbackId, feedbackIds))
        .orderBy(
          asc(erc8004FeedbackResponse.blockNumber),
          asc(erc8004FeedbackResponse.transactionIndex),
          asc(erc8004FeedbackResponse.logIndex)
        )
    : []
  const documents = await latestReputationDocumentsFor([
    ...feedbackIds,
    ...responses.map((response) => response.id),
  ])
  const responsesByFeedback = new Map<string, typeof responses>()
  for (const response of responses) {
    const grouped = responsesByFeedback.get(response.feedbackId) ?? []
    grouped.push(response)
    responsesByFeedback.set(response.feedbackId, grouped)
  }
  const registryIds = [
    ...new Set(
      page.map((row) => erc8004RegistryKey(row.chainId, row.reputationRegistry))
    ),
  ]
  const registries = registryIds.length
    ? await db
        .select()
        .from(erc8004ReputationRegistry)
        .where(inArray(erc8004ReputationRegistry.id, registryIds))
    : []
  const registryById = new Map(registries.map((row) => [row.id, row]))

  const items = page.map((row) => ({
    ...serializeRow(row),
    // These aliases make the official tag1/tag2 transport explicit to API consumers.
    tag1: row.tag,
    tag2: row.unit,
    descriptor: documentSummary(documents.get(row.id)),
    responses: (responsesByFeedback.get(row.id) ?? []).map((response) => ({
      ...serializeRow(response),
      descriptor: documentSummary(documents.get(response.id)),
    })),
    registry: registryById.get(
      erc8004RegistryKey(row.chainId, row.reputationRegistry)
    )
      ? serializeRow(
          registryById.get(
            erc8004RegistryKey(row.chainId, row.reputationRegistry)
          )!
        )
      : null,
  }))
  const last = page.at(-1)
  return c.json({
    items,
    page: {
      limit: query.limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeFeedbackCursor({
              blockNumber: last.blockNumber.toString(),
              transactionIndex: last.transactionIndex,
              logIndex: last.logIndex,
              id: last.id,
            })
          : null,
    },
    semantics: {
      raw: true,
      score: false,
      tag: 'official NewFeedback.tag1 (exact)',
      unit: 'official NewFeedback.tag2 (exact; never normalized)',
      response: 'append-only statement; does not validate or erase feedback',
      revocation: 'current active status; creation history remains present',
    },
  })
})

/** Bulk reverse lookup. It exposes qualified relations, never a misleading `isAgent` boolean. */
app.get('/accounts/:address', async (c) => {
  const addressRaw = c.req.param('address')
  if (!isAddress(addressRaw, { strict: false })) {
    return c.json({ error: 'address must be an EVM address' }, 400)
  }
  const address = addressRaw.toLowerCase() as Hex
  const rows = await db
    .select()
    .from(erc8004Agent)
    .where(
      or(eq(erc8004Agent.owner, address), eq(erc8004Agent.agentWallet, address))
    )
    .orderBy(
      asc(erc8004Agent.chainId),
      asc(erc8004Agent.registry),
      asc(erc8004Agent.agentId)
    )
  const documents = await latestDocumentsFor(rows.map((row) => row.id))
  const owns = rows
    .filter((row) => row.owner === address)
    .map((row) => agentSummary(row, ['owner'], documents.get(row.id)))
  const verifiedWalletFor = rows
    .filter((row) => row.agentWallet === address)
    .map((row) => agentSummary(row, ['verified_wallet'], documents.get(row.id)))
  return c.json({ address, owns, verifiedWalletFor })
})

/** Current URI work queue for the asynchronous metadata process. */
app.get('/metadata-tasks', async (c) => {
  const limitRaw = Number(c.req.query('limit') ?? 100)
  const limit = Number.isSafeInteger(limitRaw)
    ? Math.max(1, Math.min(500, limitRaw))
    : 100
  const refreshAfterRaw = Number(c.req.query('refreshAfter') ?? 86_400)
  const refreshAfter = Number.isSafeInteger(refreshAfterRaw)
    ? Math.max(300, refreshAfterRaw)
    : 86_400
  const rows = await db
    .select()
    .from(erc8004Agent)
    .orderBy(asc(erc8004Agent.updatedBlock), asc(erc8004Agent.updatedLogIndex))
  const candidates = rows.filter((row) => row.agentURI.length > 0)
  const documents = await latestDocumentsFor(candidates.map((row) => row.id))
  const now = BigInt(Math.floor(Date.now() / 1_000))
  const tasks = candidates
    .filter((row) => {
      const observed = documents.get(row.id)
      if (!observed || observed.uri !== row.agentURI) return true
      // Valid immutable IPFS/data content is fetched once. Failures and HTTPS content are retried
      // periodically so transient gateway/service outages remain observations, not permanent state.
      return (
        (observed.mutable || observed.fetchStatus !== 'ok') &&
        now - observed.fetchedAt >= BigInt(refreshAfter)
      )
    })
    .slice(0, limit)
    .map((row) => ({
      agentKey: row.id,
      chainId: Number(row.chainId),
      registry: row.registry,
      agentId: row.agentId.toString(),
      uri: row.agentURI,
      sourceBlock: row.updatedBlock.toString(),
      sourceLogIndex: row.updatedLogIndex,
    }))
  return c.json({ tasks, refreshAfter })
})

/** Work queue for feedback/response descriptors; fetching never runs in a Ponder event handler. */
app.get('/feedback-metadata-tasks', async (c) => {
  const limitRaw = Number(c.req.query('limit') ?? 100)
  const limit = Number.isSafeInteger(limitRaw)
    ? Math.max(1, Math.min(500, limitRaw))
    : 100
  const refreshAfterRaw = Number(c.req.query('refreshAfter') ?? 86_400)
  const refreshAfter = Number.isSafeInteger(refreshAfterRaw)
    ? Math.max(300, refreshAfterRaw)
    : 86_400
  const [feedbackRows, responseRows] = await Promise.all([
    db
      .select()
      .from(erc8004Feedback)
      .orderBy(
        asc(erc8004Feedback.blockNumber),
        asc(erc8004Feedback.transactionIndex),
        asc(erc8004Feedback.logIndex)
      ),
    db
      .select()
      .from(erc8004FeedbackResponse)
      .orderBy(
        asc(erc8004FeedbackResponse.blockNumber),
        asc(erc8004FeedbackResponse.transactionIndex),
        asc(erc8004FeedbackResponse.logIndex)
      ),
  ])
  const feedbackById = new Map(feedbackRows.map((row) => [row.id, row]))
  const candidates = [
    ...feedbackRows
      .filter((row) => row.feedbackURI.length > 0)
      .map((row) => ({
        subjectId: row.id,
        feedbackId: row.id,
        kind: 'feedback' as const,
        uri: row.feedbackURI,
        expectedHash: row.feedbackHash,
        sourceBlock: row.blockNumber,
        sourceTransactionIndex: row.transactionIndex,
        sourceLogIndex: row.logIndex,
        context: {
          kind: 'feedback' as const,
          chainId: Number(row.chainId),
          identityRegistry: row.identityRegistry,
          agentId: row.agentId.toString(),
          reviewer: row.reviewer,
          value: row.value.toString(),
          valueDecimals: row.valueDecimals,
          tag: row.tag,
          unit: row.unit,
          endpoint: row.endpoint,
        },
      })),
    ...responseRows
      .filter(
        (row) => row.responseURI.length > 0 && feedbackById.has(row.feedbackId)
      )
      .map((row) => ({
        subjectId: row.id,
        feedbackId: row.feedbackId,
        kind: 'response' as const,
        uri: row.responseURI,
        expectedHash: row.responseHash,
        sourceBlock: row.blockNumber,
        sourceTransactionIndex: row.transactionIndex,
        sourceLogIndex: row.logIndex,
        context: { kind: 'response' as const },
      })),
  ].sort((a, b) =>
    a.sourceBlock === b.sourceBlock
      ? a.sourceTransactionIndex === b.sourceTransactionIndex
        ? a.sourceLogIndex - b.sourceLogIndex
        : a.sourceTransactionIndex - b.sourceTransactionIndex
      : a.sourceBlock < b.sourceBlock
        ? -1
        : 1
  )
  const documents = await latestReputationDocumentsFor(
    candidates.map((row) => row.subjectId)
  )
  const now = BigInt(Math.floor(Date.now() / 1_000))
  const tasks = candidates
    .filter((row) => {
      const observed = documents.get(row.subjectId)
      if (!observed || observed.uri !== row.uri) return true
      return (
        (observed.mutable || observed.fetchStatus !== 'ok') &&
        now - observed.fetchedAt >= BigInt(refreshAfter)
      )
    })
    .slice(0, limit)
    .map((row) => ({
      ...row,
      sourceBlock: row.sourceBlock.toString(),
    }))
  return c.json({ tasks, refreshAfter })
})

app.get('/agents/:namespace/:chainId/:registry/:agentId', async (c) => {
  const namespace = c.req.param('namespace')
  const chainIdRaw = c.req.param('chainId')
  const registryRaw = c.req.param('registry')
  const agentIdRaw = c.req.param('agentId')
  if (namespace !== 'eip155')
    return c.json({ error: 'unsupported namespace' }, 400)
  if (!/^\d+$/.test(chainIdRaw) || !Number.isSafeInteger(Number(chainIdRaw))) {
    return c.json({ error: 'chainId must be a decimal safe integer' }, 400)
  }
  if (!isAddress(registryRaw, { strict: false })) {
    return c.json({ error: 'registry must be an EVM address' }, 400)
  }
  if (!/^\d+$/.test(agentIdRaw))
    return c.json({ error: 'agentId must be decimal' }, 400)

  const chainId = Number(chainIdRaw)
  const registry = registryRaw.toLowerCase() as Hex
  const agentId = BigInt(agentIdRaw)
  const agentKey = erc8004AgentKey(chainId, registry, agentId)
  const registryId = erc8004RegistryKey(chainId, registry)
  const [identity] = await db
    .select()
    .from(erc8004Agent)
    .where(eq(erc8004Agent.id, agentKey))
    .limit(1)
  if (!identity) return c.json({ error: 'agent not found' }, 404)

  const [
    registryRows,
    registryHistory,
    events,
    relations,
    uriVersions,
    documents,
  ] = await Promise.all([
    db
      .select()
      .from(erc8004Registry)
      .where(eq(erc8004Registry.id, registryId))
      .limit(1),
    db
      .select()
      .from(erc8004RegistryEvent)
      .where(eq(erc8004RegistryEvent.registryId, registryId))
      .orderBy(
        asc(erc8004RegistryEvent.blockNumber),
        asc(erc8004RegistryEvent.transactionIndex),
        asc(erc8004RegistryEvent.logIndex)
      ),
    db
      .select()
      .from(erc8004AgentEvent)
      .where(eq(erc8004AgentEvent.agentKey, agentKey))
      .orderBy(
        asc(erc8004AgentEvent.blockNumber),
        asc(erc8004AgentEvent.transactionIndex),
        asc(erc8004AgentEvent.logIndex)
      ),
    db
      .select()
      .from(erc8004AgentRelationHistory)
      .where(eq(erc8004AgentRelationHistory.agentKey, agentKey))
      .orderBy(
        asc(erc8004AgentRelationHistory.blockNumber),
        asc(erc8004AgentRelationHistory.transactionIndex),
        asc(erc8004AgentRelationHistory.logIndex)
      ),
    db
      .select()
      .from(erc8004AgentUriVersion)
      .where(eq(erc8004AgentUriVersion.agentKey, agentKey))
      .orderBy(
        asc(erc8004AgentUriVersion.blockNumber),
        asc(erc8004AgentUriVersion.transactionIndex),
        asc(erc8004AgentUriVersion.logIndex)
      ),
    offchainDb
      .select()
      .from(erc8004RegistrationDocument)
      .where(eq(erc8004RegistrationDocument.agentKey, agentKey))
      .orderBy(desc(erc8004RegistrationDocument.fetchedAt)),
  ])
  const latestDocument = documents[0]
  const endpointObservations = latestDocument
    ? await offchainDb
        .select()
        .from(erc8004EndpointObservation)
        .where(eq(erc8004EndpointObservation.documentId, latestDocument.id))
        .orderBy(asc(erc8004EndpointObservation.serviceName))
    : []

  return c.json({
    identity: serializeRow(identity),
    registry: registryRows[0] ? serializeRow(registryRows[0]) : null,
    registryHistory: registryHistory.map(serializeRow),
    events: events.map(serializeRow),
    relations: relations.map(serializeRow),
    uriVersions: uriVersions.map(serializeRow),
    registration: latestDocument ? serializeRow(latestDocument) : null,
    registrationHistory: documents.map(serializeRow),
    endpointObservations: endpointObservations.map(serializeRow),
  })
})

export default app
