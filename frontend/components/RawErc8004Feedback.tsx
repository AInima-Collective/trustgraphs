import Link from 'next/link'
import { type ReactNode } from 'react'

import { Address } from '@/components/Address'
import { Button, ButtonLink } from '@/components/Button'
import { Card } from '@/components/Card'
import { Input } from '@/components/Input'
import { SectionHeading } from '@/components/SectionHeading'

type DescriptorObservation = {
  uri: string
  finalUri: string | null
  expectedHash: string
  contentHash: string | null
  hashStatus: string
  fetchStatus: string
  fetchedAt: string
  mutable: boolean
  byteLength: number | null
  error: string | null
} | null

type Response = {
  id: string
  responder: `0x${string}`
  responseURI: string
  responseHash: string
  blockNumber: string
  transactionIndex: number
  logIndex: number
  txHash: string
  descriptor: DescriptorObservation
}

export type RawFeedback = {
  id: string
  agentId: string
  reviewer: `0x${string}`
  feedbackIndex: string
  value: string
  valueDecimals: number
  tag: string
  unit: string
  endpoint: string
  feedbackURI: string
  feedbackHash: string
  reviewerAttribution: 'attributed' | 'unattributed' | 'ambiguous'
  reviewerAgentKey: string | null
  reviewerCandidates: string[]
  reviewerAttributionEvidence: Array<{
    agentKey: string
    relationEventId: string
    blockNumber: string
    transactionIndex: number
    logIndex: number
  }>
  revoked: boolean
  revokedBlock: string | null
  responseCount: number
  blockNumber: string
  transactionIndex: number
  logIndex: number
  txHash: string
  blockHash: string
  descriptor: DescriptorObservation
  responses: Response[]
  registry: {
    proxy: string
    implementation: string
    identityRegistry: string | null
    version: string
    owner: string | null
    sourceBlock: string
  } | null
}

export type RawFeedbackResponse = {
  items: RawFeedback[]
  page: { limit: number; hasMore: boolean; nextCursor: string | null }
}

export type FeedbackFilters = {
  tag?: string
  unit?: string
  reviewer?: string
  revoked?: string
  cursor?: string
}

const displayFixed = (raw: string, decimals: number) => {
  const value = BigInt(raw)
  if (decimals === 0) return value.toString()
  const negative = value < 0n
  const digits = (negative ? -value : value)
    .toString()
    .padStart(decimals + 1, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`
}

const agentHref = (agentKey: string) => {
  const match = agentKey.match(/^agent:(eip155):(\d+):(0x[0-9a-f]{40}):(\d+)$/)
  return match
    ? `/agents/${match[1]}/${match[2]}/${match[3]}/${match[4]}`
    : null
}

const safeHttps = (value: string | null) => {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
      ? value
      : null
  } catch {
    return null
  }
}

const shortened = (value: string) =>
  value.length > 30 ? `${value.slice(0, 14)}…${value.slice(-10)}` : value

export function RawErc8004Feedback({
  data,
  filters,
  canonicalPath,
}: {
  data: RawFeedbackResponse
  filters: FeedbackFilters
  canonicalPath: string
}) {
  const nextParams = new URLSearchParams()
  if (filters.tag) nextParams.set('feedbackTag', filters.tag)
  if (filters.unit) nextParams.set('feedbackUnit', filters.unit)
  if (filters.reviewer) nextParams.set('feedbackReviewer', filters.reviewer)
  if (filters.revoked) nextParams.set('feedbackRevoked', filters.revoked)
  if (data.page.nextCursor)
    nextParams.set('feedbackCursor', data.page.nextCursor)

  return (
    <section className="space-y-5" aria-label="Raw ERC-8004 feedback">
      <div>
        <SectionHeading>Raw ERC-8004 feedback</SectionHeading>
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-text-muted">
          These are unaggregated on-chain signals. Tags and units are not
          comparable across policies; nothing here is a global score, a truth
          claim, proof quality, or a TrustGraph edge.
        </p>
      </div>

      <form
        method="get"
        action={canonicalPath}
        className="grid gap-3 border border-border bg-surface-2 p-4 md:grid-cols-5"
      >
        <Filter label="Tag (exact)">
          <Input
            name="feedbackTag"
            defaultValue={filters.tag}
            maxLength={256}
          />
        </Filter>
        <Filter label="Unit / tag2 (exact)">
          <Input
            name="feedbackUnit"
            defaultValue={filters.unit}
            maxLength={256}
          />
        </Filter>
        <Filter label="Reviewer address">
          <Input
            name="feedbackReviewer"
            defaultValue={filters.reviewer}
            placeholder="0x…"
          />
        </Filter>
        <Filter label="Revocation state">
          <select
            name="feedbackRevoked"
            defaultValue={filters.revoked ?? 'all'}
            className="h-9 w-full border border-input bg-surface px-3 text-sm text-text focus:border-ink focus-visible:outline-none"
          >
            <option value="all">All history</option>
            <option value="active">Active only</option>
            <option value="revoked">Revoked only</option>
          </select>
        </Filter>
        <div className="flex items-end gap-2">
          <Button type="submit" className="flex-1">
            Filter
          </Button>
          <ButtonLink
            href={canonicalPath}
            variant="outline"
            aria-label="Clear filters"
          >
            Clear
          </ButtonLink>
        </div>
      </form>

      {data.items.length === 0 ? (
        <Card type="outline" size="md" className="text-sm text-text-muted">
          No raw feedback matches these exact filters.
        </Card>
      ) : (
        <ol className="space-y-4">
          {data.items.map((feedback) => (
            <li key={feedback.id}>
              <Card type="primary" size="md" className="space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="flex flex-wrap items-center gap-2 text-xs text-text">
                      <span className="border border-hairline-strong px-2 py-1 font-mono">
                        {feedback.tag || 'untagged'}
                      </span>
                      <span className="text-text-subtle">/</span>
                      <span className="border border-border px-2 py-1 font-mono text-text-muted">
                        {feedback.unit || 'no unit'}
                      </span>
                    </p>
                    <p className="mt-3 font-mono text-2xl tabular-nums text-text">
                      {displayFixed(feedback.value, feedback.valueDecimals)}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-text-subtle">
                      raw value {feedback.value} · decimals{' '}
                      {feedback.valueDecimals}
                    </p>
                  </div>
                  <span
                    className={`border px-2 py-1 text-[10px] uppercase tracking-wider ${
                      feedback.revoked
                        ? 'border-warn/40 text-warn'
                        : 'border-success/40 text-success'
                    }`}
                  >
                    {feedback.revoked
                      ? 'Revoked · history retained'
                      : 'Active feedback'}
                  </span>
                </div>

                <div className="grid gap-px border border-border bg-border md:grid-cols-2">
                  <div className="bg-surface p-3">
                    <p className="text-[9px] uppercase tracking-wider text-text-subtle">
                      On-chain reviewer
                    </p>
                    <div className="mt-2 text-xs">
                      <Address
                        address={feedback.reviewer}
                        displayMode="full"
                        showNavIcon
                      />
                    </div>
                    <Attribution feedback={feedback} />
                  </div>
                  <div className="bg-surface p-3">
                    <p className="text-[9px] uppercase tracking-wider text-text-subtle">
                      Canonical event position
                    </p>
                    <p className="mt-2 font-mono text-xs text-text">
                      block {feedback.blockNumber} · tx{' '}
                      {feedback.transactionIndex} · log {feedback.logIndex}
                    </p>
                    <p className="mt-1 break-all font-mono text-[10px] text-text-subtle">
                      {feedback.txHash}
                    </p>
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <PointerBlock
                    title="On-chain pointers"
                    endpoint={feedback.endpoint}
                    uri={feedback.feedbackURI}
                    hash={feedback.feedbackHash}
                  />
                  <DescriptorBlock descriptor={feedback.descriptor} />
                </div>

                {feedback.responses.length > 0 && (
                  <div className="space-y-2 border-t border-border pt-4">
                    <p className="text-[10px] uppercase tracking-wider text-text-subtle">
                      Appended responses ({feedback.responses.length})
                    </p>
                    <p className="text-[10px] text-text-subtle">
                      Anyone may append a response. A response neither validates
                      nor erases the feedback.
                    </p>
                    {feedback.responses.map((response) => (
                      <div
                        key={response.id}
                        className="grid gap-3 border border-border p-3 text-xs md:grid-cols-2"
                      >
                        <div>
                          <p className="text-[9px] uppercase text-text-subtle">
                            Responder
                          </p>
                          <div className="mt-1">
                            <Address
                              address={response.responder}
                              displayMode="full"
                              showNavIcon
                            />
                          </div>
                          <p className="mt-2 break-all font-mono text-[10px] text-text-subtle">
                            URI: {response.responseURI || 'none'}
                          </p>
                          <p className="mt-1 break-all font-mono text-[10px] text-text-subtle">
                            Hash: {response.responseHash}
                          </p>
                        </div>
                        <DescriptorBlock
                          descriptor={response.descriptor}
                          compact
                        />
                      </div>
                    ))}
                  </div>
                )}

                {feedback.registry && (
                  <details className="border-t border-border pt-3 text-[10px] text-text-subtle">
                    <summary className="cursor-pointer uppercase tracking-wider text-text-muted">
                      Reputation Registry provenance
                    </summary>
                    <div className="mt-2 space-y-1 break-all font-mono">
                      <p>Proxy: {feedback.registry.proxy}</p>
                      <p>Implementation: {feedback.registry.implementation}</p>
                      <p>Version: {feedback.registry.version}</p>
                      <p>Indexed from block: {feedback.registry.sourceBlock}</p>
                    </div>
                  </details>
                )}
              </Card>
            </li>
          ))}
        </ol>
      )}

      {data.page.hasMore && data.page.nextCursor && (
        <div className="flex justify-end">
          <ButtonLink
            href={`${canonicalPath}?${nextParams.toString()}`}
            variant="outline"
          >
            Older feedback
          </ButtonLink>
        </div>
      )}
    </section>
  )
}

function Filter({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="space-y-1">
      <span className="text-[9px] uppercase tracking-wider text-text-subtle">
        {label}
      </span>
      {children}
    </label>
  )
}

function Attribution({ feedback }: { feedback: RawFeedback }) {
  if (feedback.reviewerAttribution === 'unattributed') {
    return (
      <p className="mt-2 text-[10px] text-text-subtle">
        Unattributed: no verified-wallet relation existed before this event.
      </p>
    )
  }
  if (feedback.reviewerAttribution === 'ambiguous') {
    return (
      <div className="mt-2 text-[10px] text-warn">
        <p>
          Ambiguous: this wallet was verified for multiple agents at this event.
        </p>
        <p className="mt-1 break-all font-mono">
          {feedback.reviewerCandidates.join(', ')}
        </p>
      </div>
    )
  }
  const href = feedback.reviewerAgentKey
    ? agentHref(feedback.reviewerAgentKey)
    : null
  const evidence = feedback.reviewerAttributionEvidence[0]
  return (
    <p className="mt-2 text-[10px] text-success">
      Historically attributed to{' '}
      {href && feedback.reviewerAgentKey ? (
        <Link href={href} className="font-mono underline underline-offset-2">
          {shortened(feedback.reviewerAgentKey)}
        </Link>
      ) : (
        shortened(feedback.reviewerAgentKey ?? 'unknown agent')
      )}
      {evidence ? ` from wallet relation at block ${evidence.blockNumber}` : ''}
      .
    </p>
  )
}

function PointerBlock({
  title,
  endpoint,
  uri,
  hash,
}: {
  title: string
  endpoint: string
  uri: string
  hash: string
}) {
  return (
    <div className="space-y-2 text-xs">
      <p className="text-[9px] uppercase tracking-wider text-text-subtle">
        {title}
      </p>
      <p className="break-all font-mono text-[10px] text-text-muted">
        Endpoint: {endpoint || 'none'}
      </p>
      <p className="break-all font-mono text-[10px] text-text-muted">
        Descriptor URI: {uri || 'none'}
      </p>
      <p className="break-all font-mono text-[10px] text-text-muted">
        Descriptor hash: {hash}
      </p>
    </div>
  )
}

function DescriptorBlock({
  descriptor,
  compact = false,
}: {
  descriptor: DescriptorObservation
  compact?: boolean
}) {
  if (!descriptor) {
    return (
      <div className="text-[10px] text-text-subtle">
        <p className="uppercase tracking-wider">External descriptor</p>
        <p className="mt-2">Not fetched, absent, or still queued.</p>
      </div>
    )
  }
  const href = safeHttps(descriptor.finalUri ?? descriptor.uri)
  return (
    <div className="text-[10px] text-text-subtle">
      <p className="uppercase tracking-wider">External descriptor</p>
      <p
        className={`mt-2 ${descriptor.fetchStatus === 'ok' ? 'text-success' : 'text-warn'}`}
      >
        {descriptor.fetchStatus} · hash {descriptor.hashStatus}
        {descriptor.mutable
          ? ' · mutable HTTPS observation'
          : ' · immutable pointer'}
      </p>
      {!compact && descriptor.contentHash && (
        <p className="mt-1 break-all font-mono">
          Observed bytes: {descriptor.contentHash}
        </p>
      )}
      {descriptor.error && <p className="mt-1 text-warn">{descriptor.error}</p>}
      {href && (
        <Link
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block underline underline-offset-2"
        >
          Open external JSON
        </Link>
      )}
    </div>
  )
}
