'use client'

import { LoaderCircle, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import type { Hex } from 'viem'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { APIS } from '@/lib/config'
import {
  type GraphConfiguration,
  type GraphEndorsement,
  type GraphEpoch,
  type GraphLineage,
  type ReferralBudget,
  type ReferralEdge,
  fetchGraphEndorsements,
  fetchGraphLineage,
  fetchReferralDiagnostics,
} from '@/lib/graph-lineage'

const compact = (value: string) => `${value.slice(0, 12)}…${value.slice(-6)}`
const percent = (weight: string) => {
  const basisPoints = (BigInt(weight) * 10_000n) / 1_000_000_000_000_000_000n
  return `${Number(basisPoints) / 100}%`
}
const statusColor = (status: GraphEndorsement['status']) =>
  status === 'active'
    ? 'bg-emerald-100 text-emerald-900'
    : status === 'verification-unavailable'
      ? 'bg-amber-100 text-amber-900'
      : 'bg-slate-200 text-slate-900'

export const GraphLineageView = ({ lineageId }: { lineageId: Hex }) => {
  const [lineage, setLineage] = useState<GraphLineage | null>(null)
  const [configurations, setConfigurations] = useState<GraphConfiguration[]>([])
  const [epochs, setEpochs] = useState<GraphEpoch[]>([])
  const [endorsements, setEndorsements] = useState<GraphEndorsement[]>([])
  const [referrals, setReferrals] = useState<ReferralEdge[]>([])
  const [referralBudget, setReferralBudget] = useState<ReferralBudget | null>(
    null
  )
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setProblem(null)
    try {
      const overview = await fetchGraphLineage(APIS.ponder, lineageId)
      const current = overview.configurations.find((entry) => entry.current)
      const [issued, received, diagnostics] = await Promise.all([
        fetchGraphEndorsements(APIS.ponder, { issuer: lineageId }),
        fetchGraphEndorsements(APIS.ponder, { subject: lineageId }),
        current
          ? fetchReferralDiagnostics(APIS.ponder, current.scopeHash)
          : Promise.resolve(null),
      ])
      const claims = new Map(
        [...issued, ...received].map((claim) => [claim.id, claim])
      )
      setLineage(overview.lineage)
      setConfigurations(overview.configurations)
      setEpochs(overview.epochs)
      setEndorsements([...claims.values()])
      setReferrals(
        diagnostics?.edges.filter(
          (edge) =>
            edge.issuerLineageId === lineageId ||
            edge.subjectLineageId === lineageId
        ) ?? []
      )
      setReferralBudget(
        diagnostics?.budgets.find(
          (budget) => budget.issuerLineageId === lineageId
        ) ?? null
      )
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [lineageId])

  const current = configurations.find((configuration) => configuration.current)
  const referralById = useMemo(
    () => new Map(referrals.map((edge) => [edge.endorsementId, edge])),
    [referrals]
  )

  return (
    <main className="max-w-6xl space-y-6" aria-labelledby="lineage-title">
      <header className="space-y-2">
        <Link className="text-sm underline" href="/graph-lineages">
          ← All graph lineages
        </Link>
        <h1 id="lineage-title" className="text-2xl">
          {lineage?.displayName ?? 'Graph lineage'}
        </h1>
        <p className="break-all font-mono text-xs">{lineageId}</p>
        <p className="text-sm text-muted-foreground">
          Advisory provenance only. Endorsements never change an account score,
          Merkle root, proof, or active trust-compose weight.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={load}
          disabled={loading}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh rotation and expiry status
        </Button>
      </header>
      {loading && (
        <p className="text-sm">
          <LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />
          Confirming authority and configuration state on-chain…
        </p>
      )}
      {problem && (
        <Card type="outline" size="md">
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        </Card>
      )}

      {lineage && current && (
        <section className="space-y-3" aria-labelledby="identity-heading">
          <h2 id="identity-heading" className="text-lg font-medium">
            Qualified actor and current configuration
          </h2>
          <div className="grid gap-3 md:grid-cols-3">
            <Card type="outline" size="sm" className="space-y-1">
              <p className="text-xs text-muted-foreground">
                Authority / controller
              </p>
              <p className="break-all font-mono text-xs">{current.authority}</p>
              <p className="break-all font-mono text-xs">
                {current.controller}
              </p>
              <p className="text-xs">
                {current.authenticatedLive
                  ? 'authenticated live'
                  : 'suspended by rotation or unavailable verification'}
              </p>
            </Card>
            <Card type="outline" size="sm" className="space-y-1">
              <p className="text-xs text-muted-foreground">
                Method / scope / identity domain
              </p>
              <p className="font-mono text-xs">{compact(current.methodId)}</p>
              <p className="font-mono text-xs">{compact(current.scopeHash)}</p>
              <p className="font-mono text-xs">
                {compact(current.identityDomain)}
              </p>
            </Card>
            <Card type="outline" size="sm" className="space-y-1">
              <p className="text-xs text-muted-foreground">
                Family / program / params
              </p>
              <p className="font-mono text-xs">{compact(current.familyId)}</p>
              <p className="font-mono text-xs">{compact(current.programId)}</p>
              <p className="font-mono text-xs">{compact(current.paramsHash)}</p>
            </Card>
          </div>
          <p className="break-all text-xs text-muted-foreground">
            instance registry {lineage.instanceRegistry} · instance{' '}
            {lineage.instanceId}
          </p>
          {referralBudget && (
            <Card type="outline" size="sm" className="space-y-1">
              <p className="text-xs text-muted-foreground">
                Current active referral budget for this scope
              </p>
              <p className="text-sm">
                spent {percent(referralBudget.spent)} · unused{' '}
                {percent(referralBudget.unused)}
              </p>
              <p className="break-all font-mono text-xs">
                scope {referralBudget.scopeHash}
              </p>
            </Card>
          )}
        </section>
      )}

      <section className="space-y-3" aria-labelledby="endorsements-heading">
        <h2 id="endorsements-heading" className="text-lg font-medium">
          Typed scoped endorsement history
        </h2>
        <p className="text-sm text-muted-foreground">
          Integrity, methodology, agreement, and warning claims are evidence
          only. Only active referral records are eligible for the later advisory
          matrix.
        </p>
        <div className="space-y-2">
          {endorsements.map((endorsement) => {
            const referral = referralById.get(endorsement.id)
            const overlaps =
              (endorsement.overlap ?? referral?.overlap)
                ? Object.entries(endorsement.overlap ?? referral!.overlap)
                    .filter(([, present]) => present)
                    .map(([label]) => label)
                : []
            return (
              <Card
                key={endorsement.id}
                type="outline"
                size="sm"
                className="space-y-2"
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <strong>{endorsement.kind}</strong>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${statusColor(endorsement.status)}`}
                  >
                    {endorsement.status}
                  </span>
                  <span>{percent(endorsement.weight)} weight</span>
                  {endorsement.evidenceMutable && (
                    <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
                      mutable evidence
                    </span>
                  )}
                  {overlaps.map((overlap) => (
                    <span
                      key={overlap}
                      className="rounded bg-violet-100 px-2 py-0.5 text-xs text-violet-900"
                    >
                      shared {overlap}
                    </span>
                  ))}
                </div>
                <p className="break-all font-mono text-xs">
                  {compact(endorsement.issuerLineageId)} →{' '}
                  {compact(endorsement.subjectLineageId)}
                </p>
                <p className="break-all font-mono text-xs">
                  scope {endorsement.scopeHash}
                </p>
                <p className="break-all text-xs">
                  evidence {endorsement.evidenceURI} · digest{' '}
                  {endorsement.evidenceDigest}
                </p>
                <p className="text-xs text-muted-foreground">
                  sequence {endorsement.sequence} · valid{' '}
                  {new Date(
                    Number(endorsement.validFrom) * 1000
                  ).toLocaleString()}{' '}
                  –{' '}
                  {new Date(
                    Number(endorsement.validUntil) * 1000
                  ).toLocaleString()}
                </p>
                <p className="break-all font-mono text-xs text-muted-foreground">
                  issuer config {endorsement.issuerConfigurationId} · subject
                  config {endorsement.subjectConfigurationId}
                </p>
                {(endorsement.supersedes ||
                  endorsement.supersededBy ||
                  endorsement.revocationRef) && (
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    supersedes {endorsement.supersedes ?? 'none'} · superseded
                    by {endorsement.supersededBy ?? 'none'} · revocation{' '}
                    {endorsement.revocationRef ?? 'none'}
                  </p>
                )}
              </Card>
            )
          })}
        </div>
        {!loading && endorsements.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No endorsement history for this lineage.
          </p>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="config-history-heading">
        <h2 id="config-history-heading" className="text-lg font-medium">
          Controller and configuration history
        </h2>
        <div className="space-y-2">
          {configurations.map((configuration) => (
            <Card
              key={configuration.id}
              type="outline"
              size="sm"
              className="space-y-2"
            >
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <strong>v{configuration.version}</strong>
                <span>{configuration.current ? 'current' : 'superseded'}</span>
                <span>
                  {configuration.authenticatedLive
                    ? 'authenticated live'
                    : 'not live'}
                </span>
                <span>activated block {configuration.activatedBlock}</span>
              </div>
              <p className="break-all font-mono text-xs">
                configuration {configuration.id}
              </p>
              <div className="grid gap-1 md:grid-cols-2">
                <p className="break-all font-mono text-xs">
                  authority {configuration.authority}
                </p>
                <p className="break-all font-mono text-xs">
                  controller {configuration.controller}
                </p>
                <p className="break-all font-mono text-xs">
                  program {configuration.programId}
                </p>
                <p className="break-all font-mono text-xs">
                  snapshot {configuration.snapshot}
                </p>
                <p className="break-all font-mono text-xs">
                  verifier {configuration.verifier}
                </p>
                <p className="break-all font-mono text-xs">
                  accumulator {configuration.registryOrAccumulator}
                </p>
                <p className="break-all font-mono text-xs">
                  params {configuration.paramsHash}
                </p>
                <p className="break-all font-mono text-xs">
                  family {configuration.familyId} · method{' '}
                  {configuration.methodId}
                </p>
                <p className="break-all font-mono text-xs">
                  scope {configuration.scopeHash} · identity domain{' '}
                  {configuration.identityDomain}
                </p>
                <p className="break-all font-mono text-xs">
                  source-lineage policy {configuration.sourceLineagePolicyHash}
                </p>
              </div>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="epoch-history-heading">
        <h2 id="epoch-history-heading" className="text-lg font-medium">
          Exact epoch identities
        </h2>
        <p className="text-sm text-muted-foreground">
          Each epoch pins its configuration, checkpoint, input-freeze block,
          root, canonical blob/CID commitments, total, verifier acceptance
          block, and program key.
        </p>
        <div className="space-y-2">
          {epochs.map((epoch) => (
            <Card key={epoch.id} type="outline" size="sm" className="space-y-2">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <strong>checkpoint {epoch.checkpointId}</strong>
                <span>configuration v{epoch.configurationVersion}</span>
                <span>freeze block {epoch.freezeBlock}</span>
                <span>accepted block {epoch.acceptedAtBlock}</span>
                <span>total {epoch.totalValue}</span>
              </div>
              <p className="break-all font-mono text-xs">epoch {epoch.id}</p>
              <p className="break-all font-mono text-xs">
                configuration {epoch.configurationId}
              </p>
              <p className="break-all font-mono text-xs">root {epoch.root}</p>
              <p className="break-all font-mono text-xs">
                blob sha256 {epoch.blobSha256}
              </p>
              <p className="break-all font-mono text-xs">CID {epoch.cid}</p>
              <p className="break-all font-mono text-xs">
                CID digest {epoch.cidDigest}
              </p>
              <p className="break-all font-mono text-xs">
                program vkey {epoch.programVKey}
              </p>
            </Card>
          ))}
        </div>
      </section>
    </main>
  )
}
