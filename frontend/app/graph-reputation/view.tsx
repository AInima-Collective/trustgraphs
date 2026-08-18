'use client'

import { LoaderCircle, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import type { Hex } from 'viem'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { APIS } from '@/lib/config'
import {
  type GraphLineage,
  type GraphRecommendationResult,
  fetchGraphLineages,
  fetchGraphRecommendations,
} from '@/lib/graph-lineage'

const SCALE = 1_000_000_000_000_000_000n
const compact = (value: string) => `${value.slice(0, 12)}…${value.slice(-6)}`
const percent = (weight: string) => {
  const hundredthPercent = (BigInt(weight) * 10_000n) / SCALE
  return `${Number(hundredthPercent) / 100}%`
}
const equalPrior = (lineageIds: Hex[]) => {
  const sorted = [...lineageIds].sort()
  const base = SCALE / BigInt(sorted.length)
  let remainder = SCALE - base * BigInt(sorted.length)
  return sorted.map((lineageId) => {
    const weight = base + (remainder > 0n ? 1n : 0n)
    if (remainder > 0n) remainder--
    return { lineageId, weight: weight.toString() }
  })
}

export const GraphReputationView = () => {
  const [lineages, setLineages] = useState<GraphLineage[]>([])
  const [roots, setRoots] = useState<Hex[]>([])
  const [scopeHash, setScopeHash] = useState('')
  const [result, setResult] = useState<GraphRecommendationResult | null>(null)
  const [manual, setManual] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setProblem(null)
    try {
      const rows = await fetchGraphLineages(APIS.ponder)
      setLineages(rows)
      const live = rows.filter((row) => row.authenticatedLive)
      const anchor = live[0]
      const compatible = anchor
        ? live.filter(
            (row) =>
              row.chainId === anchor.chainId &&
              row.registry.toLowerCase() === anchor.registry.toLowerCase()
          )
        : []
      setRoots((current) =>
        current.length > 0
          ? current
          : compatible.slice(0, 3).map((row) => row.id)
      )
      setScopeHash(
        (current) => current || live[0]?.currentConfiguration?.scopeHash || ''
      )
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const run = async () => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(scopeHash) || roots.length === 0) {
      setProblem('Choose at least one root and enter a bytes32 scope hash.')
      return
    }
    setRunning(true)
    setProblem(null)
    try {
      setResult(
        await fetchGraphRecommendations(APIS.ponder, {
          scopeHash: scopeHash as Hex,
          roots: equalPrior(roots),
        })
      )
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setRunning(false)
    }
  }

  const budgetByLineage = useMemo(
    () => new Map(result?.budgets.map((row) => [row.issuerLineageId, row])),
    [result]
  )
  const selectedAnchor = lineages.find((lineage) => lineage.id === roots[0])

  return (
    <main className="max-w-6xl space-y-6" aria-labelledby="reputation-title">
      <header className="space-y-2">
        <Link className="text-sm underline" href="/graph-lineages">
          ← Graph lineage provenance
        </Link>
        <h1 id="reputation-title" className="text-2xl">
          Advisory graph reputation
        </h1>
        <p className="text-sm text-muted-foreground">
          Select a sparse set of trusted roots. The indexer uses only a previous
          finalized epoch and active, version-pinned referrals. This screen
          never applies weights, changes defaults, or prepares a transaction.
        </p>
      </header>

      <Card type="outline" size="md" className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-medium">Trusted-root boundary</h2>
          <Button
            type="button"
            variant="outline"
            onClick={load}
            disabled={loading}
          >
            <RefreshCw className="mr-2 h-4 w-4" /> Refresh lineages
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Roots receive an equal exact fixed-point prior. There is deliberately
          no uniform prior over permissionless candidates.
        </p>
        <label className="block space-y-1 text-sm">
          <span>Referral scope (bytes32)</span>
          <input
            className="w-full rounded border bg-background px-3 py-2 font-mono text-xs"
            value={scopeHash}
            onChange={(event) => setScopeHash(event.target.value)}
            spellCheck={false}
          />
        </label>
        <div className="grid gap-2 md:grid-cols-2">
          {lineages.map((lineage) => {
            const selected = roots.includes(lineage.id)
            const compatible =
              !selectedAnchor ||
              (lineage.chainId === selectedAnchor.chainId &&
                lineage.registry.toLowerCase() ===
                  selectedAnchor.registry.toLowerCase())
            return (
              <label
                key={lineage.id}
                className="flex items-start gap-2 rounded border p-3 text-sm"
              >
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={
                    !lineage.authenticatedLive ||
                    !compatible ||
                    (!selected && roots.length >= 8)
                  }
                  onChange={(event) =>
                    setRoots((current) =>
                      event.target.checked
                        ? [...current, lineage.id]
                        : current.filter((id) => id !== lineage.id)
                    )
                  }
                />
                <span className="min-w-0">
                  <strong className="block">{lineage.displayName}</strong>
                  <span className="block break-all font-mono text-xs text-muted-foreground">
                    {lineage.id}
                  </span>
                  {!lineage.authenticatedLive && (
                    <span className="text-xs text-amber-700">
                      not canonically live
                    </span>
                  )}
                  {!selected && lineage.authenticatedLive && !compatible && (
                    <span className="text-xs text-amber-700">
                      different chain or lineage registry
                    </span>
                  )}
                </span>
              </label>
            )
          })}
        </div>
        <Button
          type="button"
          onClick={run}
          disabled={running || loading || roots.length === 0}
        >
          {running && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />}
          Compute finalized recommendation
        </Button>
      </Card>

      {problem && (
        <Card type="outline" size="md">
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Failure is closed: no recommendation is substituted and composition
            policy remains unchanged.
          </p>
        </Card>
      )}

      {result && (
        <>
          <section className="space-y-3" aria-labelledby="cutoff-heading">
            <h2 id="cutoff-heading" className="text-lg font-medium">
              Bound result
            </h2>
            <div className="grid gap-3 md:grid-cols-3">
              <Card type="outline" size="sm" className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  Finalized cutoff
                </p>
                <p>block {result.cutoff.block}</p>
                <p className="text-xs">
                  {new Date(
                    Number(result.cutoff.timestamp) * 1000
                  ).toLocaleString()}
                </p>
                <p className="break-all font-mono text-xs">
                  scope {result.cutoff.scopeHash}
                </p>
              </Card>
              <Card type="outline" size="sm" className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  Deterministic fixed point
                </p>
                <p>
                  {result.algorithm.iterations} iterations · residual{' '}
                  {result.algorithm.residual}
                </p>
                <p>
                  {result.algorithm.converged
                    ? 'within declared error bound'
                    : 'not converged'}
                </p>
                <p>λ {percent(result.algorithm.damping)}</p>
              </Card>
              <Card type="outline" size="sm" className="space-y-1">
                <p className="text-xs text-muted-foreground">Commitments</p>
                <p className="break-all font-mono text-xs">
                  input {result.inputCommitment}
                </p>
                <p className="break-all font-mono text-xs">
                  result {result.resultCommitment}
                </p>
              </Card>
            </div>
          </section>

          <section
            className="space-y-3"
            aria-labelledby="recommendations-heading"
          >
            <h2 id="recommendations-heading" className="text-lg font-medium">
              Ranked recommendation and manual comparison
            </h2>
            <p className="text-sm text-muted-foreground">
              Manual values below are local scratch inputs only. They are not
              sent, saved, signed, or applied.
            </p>
            <div className="space-y-3">
              {result.recommendations.map((entry) => {
                const budget = budgetByLineage.get(entry.lineageId)
                const overlaps = Object.entries(entry.overlap)
                  .filter(([, present]) => present)
                  .map(([name]) => name)
                const manualValue = manual[entry.lineageId] ?? ''
                const manualDelta =
                  manualValue === ''
                    ? null
                    : Number(manualValue) -
                      Number(percent(entry.recommendedWeight).slice(0, -1))
                return (
                  <Card
                    key={entry.lineageId}
                    type="outline"
                    size="md"
                    className="space-y-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h3 className="font-medium">
                          #{entry.rank} {entry.displayName}
                        </h3>
                        <p className="font-mono text-xs">{entry.lineageId}</p>
                      </div>
                      <span
                        className={`rounded px-2 py-1 text-xs ${entry.eligible ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900'}`}
                      >
                        {entry.eligibilityReason}
                      </span>
                    </div>
                    <div className="grid gap-2 text-sm md:grid-cols-4">
                      <p>
                        score <strong>{percent(entry.score)}</strong>
                      </p>
                      <p>
                        recommended{' '}
                        <strong>{percent(entry.recommendedWeight)}</strong>
                      </p>
                      <p>
                        family mass <strong>{percent(entry.familyMass)}</strong>
                      </p>
                      <p>
                        budget{' '}
                        {budget
                          ? `${percent(budget.spent)} / ${percent(budget.unused)} unused`
                          : 'none'}
                      </p>
                    </div>
                    <label className="block max-w-xs space-y-1 text-xs">
                      <span>Manual comparison (%)</span>
                      <input
                        className="w-full rounded border bg-background px-2 py-1"
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        value={manualValue}
                        onChange={(event) =>
                          setManual((current) => ({
                            ...current,
                            [entry.lineageId]: event.target.value,
                          }))
                        }
                      />
                      {manualDelta !== null && Number.isFinite(manualDelta) && (
                        <span>
                          {manualDelta >= 0 ? '+' : ''}
                          {manualDelta.toFixed(2)} percentage points vs
                          recommendation
                        </span>
                      )}
                    </label>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {overlaps.map((overlap) => (
                        <span
                          key={overlap}
                          className="rounded bg-violet-100 px-2 py-1 text-violet-900"
                        >
                          shared {overlap}
                        </span>
                      ))}
                      {entry.evidenceMutable && (
                        <span className="rounded bg-amber-100 px-2 py-1 text-amber-900">
                          mutable referral evidence
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      configuration {compact(entry.configurationId)} · epoch{' '}
                      {compact(entry.epochId)} · next incoming expiry{' '}
                      {entry.nextReferralExpiry
                        ? new Date(
                            Number(entry.nextReferralExpiry) * 1000
                          ).toLocaleString()
                        : 'none'}
                    </p>
                    <div className="space-y-1 text-xs">
                      <p className="font-medium">Trusted ingress</p>
                      {entry.rootIngress.map((ingress) => (
                        <p key={ingress.rootLineageId}>
                          {compact(ingress.rootLineageId)} →{' '}
                          {percent(ingress.mass)}
                        </p>
                      ))}
                      {entry.paths.map((path) => (
                        <p
                          key={path.rootLineageId}
                          className="break-all font-mono text-muted-foreground"
                        >
                          strongest path{' '}
                          {path.lineageIds.map(compact).join(' → ')} (
                          {percent(path.strength)})
                        </p>
                      ))}
                    </div>
                  </Card>
                )
              })}
            </div>
          </section>

          <section
            className="grid gap-3 md:grid-cols-2"
            aria-label="Concentration and sensitivity diagnostics"
          >
            <Card type="outline" size="md" className="space-y-2">
              <h2 className="font-medium">Effective family mass</h2>
              {result.families.map((family) => (
                <p key={family.familyId} className="text-xs">
                  <span className="font-mono">{compact(family.familyId)}</span>{' '}
                  · {percent(family.mass)}
                </p>
              ))}
            </Card>
            <Card type="outline" size="md" className="space-y-2">
              <h2 className="font-medium">Leave-one-root-out sensitivity</h2>
              {result.sensitivity.map((row) => (
                <p key={row.omittedRoot} className="text-xs">
                  omit{' '}
                  <span className="font-mono">{compact(row.omittedRoot)}</span>{' '}
                  ·{' '}
                  {row.l1Distance === null
                    ? 'single-root boundary'
                    : `${percent(row.l1Distance)} L1`}
                </p>
              ))}
              <p className="text-xs text-muted-foreground">
                Next active-set expiry:{' '}
                {result.nextExpiry
                  ? new Date(Number(result.nextExpiry) * 1000).toLocaleString()
                  : 'none'}
              </p>
            </Card>
          </section>

          <Card type="outline" size="md" className="space-y-1">
            {result.warnings.map((warning) => (
              <p key={warning} className="text-xs">
                • {warning}
              </p>
            ))}
          </Card>
        </>
      )}
    </main>
  )
}
