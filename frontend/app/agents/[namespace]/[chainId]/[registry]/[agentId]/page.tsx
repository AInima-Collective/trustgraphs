import { ArrowUpRight } from 'lucide-react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { isAddress } from 'viem'

import { Address } from '@/components/Address'
import { SectionHeading } from '@/components/SectionHeading'
import { APIS } from '@/lib/config'

export const dynamic = 'force-dynamic'

type AgentResponse = {
  identity: {
    id: string
    chainId: string
    registry: `0x${string}`
    agentId: string
    owner: `0x${string}` | null
    agentWallet: `0x${string}` | null
    agentURI: string
    registeredBlock: string
    registeredTimestamp: string
    registeredTxHash: `0x${string}`
    updatedBlock: string
  }
  registry: {
    implementation: `0x${string}`
    version: string
    owner: `0x${string}` | null
    sourceBlock: string
    observedBlock: string
  } | null
  events: Array<{
    id: string
    kind: string
    actor: `0x${string}` | null
    from: `0x${string}` | null
    to: `0x${string}` | null
    uri: string | null
    metadataKey: string | null
    blockNumber: string
    transactionIndex: number
    logIndex: number
    timestamp: string
    txHash: `0x${string}`
  }>
  registration: {
    fetchStatus: string
    fetchedAt: string
    contentHash: string | null
    finalUri: string | null
    mutable: boolean
    error: string | null
    parsedJson: RegistrationDocument | null
  } | null
  registrationHistory: Array<{ contentHash: string | null }>
  endpointObservations: Array<{
    serviceName: string
    endpoint: string
    status: string
    httpStatus: number | null
    checkedAt: string
    latencyMs: number | null
  }>
}

type RegistrationDocument = {
  name?: string
  description?: string
  active?: boolean
  services?: Array<{ name: string; endpoint: string; version?: string }>
  supportedTrust?: string[]
}

const safeHttps = (value: string) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
      ? value
      : null
  } catch {
    return null
  }
}

const formatTimestamp = (timestamp: string) =>
  new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(Number(timestamp) * 1_000))

const fetchAgent = async (
  namespace: string,
  chainId: string,
  registry: string,
  agentId: string
): Promise<AgentResponse> => {
  const response = await fetch(
    `${APIS.ponder}/erc8004/agents/${namespace}/${chainId}/${registry}/${agentId}`,
    { cache: 'no-store' }
  )
  if (response.status === 404) notFound()
  if (!response.ok)
    throw new Error(`Agent index returned HTTP ${response.status}`)
  return response.json()
}

export default async function AgentIdentityPage({
  params,
}: {
  params: Promise<{
    namespace: string
    chainId: string
    registry: string
    agentId: string
  }>
}) {
  const values = await params
  if (
    values.namespace !== 'eip155' ||
    !/^\d+$/.test(values.chainId) ||
    !isAddress(values.registry, { strict: false }) ||
    !/^\d+$/.test(values.agentId)
  ) {
    notFound()
  }
  const canonical = {
    namespace: 'eip155',
    chainId: BigInt(values.chainId).toString(),
    registry: values.registry.toLowerCase(),
    agentId: BigInt(values.agentId).toString(),
  }
  const canonicalPath = `/agents/${canonical.namespace}/${canonical.chainId}/${canonical.registry}/${canonical.agentId}`
  if (
    values.namespace !== canonical.namespace ||
    values.chainId !== canonical.chainId ||
    values.registry !== canonical.registry ||
    values.agentId !== canonical.agentId
  ) {
    redirect(canonicalPath)
  }

  const data = await fetchAgent(
    canonical.namespace,
    canonical.chainId,
    canonical.registry,
    canonical.agentId
  )
  const registration = data.registration?.parsedJson
  const currentHash = data.registration?.contentHash
  const contentChanged = data.registrationHistory.some(
    (observation) =>
      observation.contentHash && observation.contentHash !== currentHash
  )
  const endpointByValue = new Map(
    data.endpointObservations.map((observation) => [
      observation.endpoint,
      observation,
    ])
  )

  return (
    <div className="space-y-10">
      <nav aria-label="Breadcrumb">
        <Link
          href="/networks"
          className="text-[10px] uppercase tracking-wider text-text-subtle hover:text-text"
        >
          ← Networks
        </Link>
      </nav>

      <header className="space-y-4 border-b border-border pb-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="tg-label text-success">ERC-8004 identity</p>
            <h1 className="mt-2 text-2xl text-text">
              {registration?.name || `Agent #${data.identity.agentId}`}
            </h1>
            <p className="mt-1 font-mono text-xs text-text-subtle">
              eip155:{data.identity.chainId}:{data.identity.registry}:
              {data.identity.agentId}
            </p>
          </div>
          <span
            className={`border px-2 py-1 text-[10px] uppercase tracking-wider ${
              registration?.active === false
                ? 'border-warn/40 text-warn'
                : 'border-success/40 text-success'
            }`}
          >
            {registration?.active === false ? 'Inactive' : 'Registered'}
          </span>
        </div>
        {registration?.description && (
          <p className="max-w-3xl text-sm leading-relaxed text-text-muted">
            {registration.description}
          </p>
        )}
      </header>

      <section className="grid gap-6 md:grid-cols-2">
        <IdentityRelation
          label="Current owner"
          address={data.identity.owner}
          empty="No current owner"
        />
        <IdentityRelation
          label="Verified agent wallet"
          address={data.identity.agentWallet}
          empty="No wallet is currently verified"
          verified
        />
      </section>

      <section className="space-y-4">
        <SectionHeading>Registration availability</SectionHeading>
        <div className="grid gap-px border border-border bg-border sm:grid-cols-3">
          <Fact
            label="Fetch status"
            value={data.registration?.fetchStatus ?? 'Not fetched'}
          />
          <Fact
            label="Content"
            value={
              data.registration?.contentHash
                ? `${data.registration.contentHash.slice(0, 12)}…`
                : 'No validated bytes'
            }
          />
          <Fact
            label="Observed"
            value={
              data.registration
                ? formatTimestamp(data.registration.fetchedAt)
                : 'Pending sidecar fetch'
            }
          />
        </div>
        {(data.registration?.mutable ||
          contentChanged ||
          data.registration?.error) && (
          <div className="border border-warn/40 bg-warn-soft p-3 text-xs text-warn">
            {data.registration?.error
              ? `Registration unavailable or invalid: ${data.registration.error}`
              : contentChanged
                ? 'This mutable registration changed between observations; the current content hash is shown above.'
                : 'This HTTPS registration is mutable and is periodically re-observed.'}
          </div>
        )}
        {data.identity.agentURI && (
          <p className="break-all font-mono text-[11px] text-text-subtle">
            On-chain URI: {data.identity.agentURI}
          </p>
        )}
      </section>

      {registration?.services && registration.services.length > 0 && (
        <section className="space-y-4">
          <SectionHeading>Advertised services</SectionHeading>
          <div className="grid gap-2 md:grid-cols-2">
            {registration.services.map((service, index) => {
              const observation = endpointByValue.get(service.endpoint)
              const href = safeHttps(service.endpoint)
              const content = (
                <>
                  <span>
                    <span className="block text-xs text-text">
                      {service.name}
                    </span>
                    <span className="mt-1 block break-all text-[10px] text-text-subtle">
                      {service.endpoint}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] uppercase text-text-muted">
                    {observation?.status ?? 'Advertised only'}
                  </span>
                </>
              )
              return href ? (
                <Link
                  key={`${service.name}:${service.endpoint}:${index}`}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start justify-between gap-4 border border-border p-3 hover:border-hairline-strong"
                >
                  {content}
                  <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-text-subtle" />
                </Link>
              ) : (
                <div
                  key={`${service.name}:${service.endpoint}:${index}`}
                  className="flex items-start justify-between gap-4 border border-border p-3"
                >
                  {content}
                </div>
              )
            })}
          </div>
          <p className="text-[10px] leading-relaxed text-text-subtle">
            Reachability is a timestamped availability observation, not proof of
            service identity, safety, or autonomy.
          </p>
        </section>
      )}

      <section className="space-y-4">
        <SectionHeading>On-chain provenance</SectionHeading>
        <div className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          <Fact
            label="Registry version"
            value={data.registry?.version ?? 'Unknown'}
          />
          <Fact
            label="Source block"
            value={data.registry?.sourceBlock ?? 'Unknown'}
          />
          <Fact
            label="Registered block"
            value={data.identity.registeredBlock}
          />
          <Fact
            label="Last identity event"
            value={data.identity.updatedBlock}
          />
        </div>
        {data.registry && (
          <div className="space-y-1 font-mono text-[10px] text-text-subtle">
            <p className="break-all">Proxy: {data.identity.registry}</p>
            <p className="break-all">
              Implementation: {data.registry.implementation}
            </p>
            {data.registry.owner && (
              <p className="break-all">Registry owner: {data.registry.owner}</p>
            )}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <SectionHeading>Identity history</SectionHeading>
        <ol className="divide-y divide-border border-y border-border">
          {[...data.events].reverse().map((event) => (
            <li
              key={event.id}
              className="grid gap-2 py-3 text-xs sm:grid-cols-[9rem_1fr_auto]"
            >
              <span className="text-text">{event.kind}</span>
              <span className="min-w-0 break-all text-text-muted">
                {event.kind === 'Transfer'
                  ? `${event.from} → ${event.to}`
                  : event.uri ||
                    event.metadataKey ||
                    event.actor ||
                    'Registry event'}
              </span>
              <span className="text-[10px] text-text-subtle">
                block {event.blockNumber} · log {event.logIndex}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

function IdentityRelation({
  label,
  address,
  empty,
  verified = false,
}: {
  label: string
  address: `0x${string}` | null
  empty: string
  verified?: boolean
}) {
  return (
    <div className="border border-border bg-surface p-4">
      <p className="text-[10px] uppercase tracking-wider text-text-subtle">
        {label}
      </p>
      <div
        className={`mt-2 text-sm ${verified && address ? 'text-success' : ''}`}
      >
        {address ? (
          <Address address={address} displayMode="full" showNavIcon />
        ) : (
          <span className="text-text-muted">{empty}</span>
        )}
      </div>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface p-3">
      <p className="text-[9px] uppercase tracking-wider text-text-subtle">
        {label}
      </p>
      <p className="mt-1 text-xs capitalize text-text">{value}</p>
    </div>
  )
}
