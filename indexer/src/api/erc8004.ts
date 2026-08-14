import { asc, desc, eq, inArray, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from 'ponder:api'
import {
  erc8004Agent,
  erc8004AgentEvent,
  erc8004AgentRelationHistory,
  erc8004AgentUriVersion,
  erc8004Registry,
  erc8004RegistryEvent,
} from 'ponder:schema'
import { type Hex, isAddress } from 'viem'

import { offchainDb } from './db'
import {
  erc8004EndpointObservation,
  erc8004RegistrationDocument,
} from '../../offchain.schema'
import { erc8004AgentKey, erc8004RegistryKey } from '../erc8004-shared'

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

  const serializePosition = <T extends Record<string, unknown>>(row: T) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === 'bigint' ? value.toString() : value,
      ])
    )

  return c.json({
    identity: serializePosition(identity),
    registry: registryRows[0] ? serializePosition(registryRows[0]) : null,
    registryHistory: registryHistory.map(serializePosition),
    events: events.map(serializePosition),
    relations: relations.map(serializePosition),
    uriVersions: uriVersions.map(serializePosition),
    registration: latestDocument ? serializePosition(latestDocument) : null,
    registrationHistory: documents.map(serializePosition),
    endpointObservations: endpointObservations.map(serializePosition),
  })
})

export default app
