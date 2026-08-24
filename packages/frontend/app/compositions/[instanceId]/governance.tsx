'use client'

import { LoaderCircle, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'

import { BreadcrumbRenderer } from '@/components/BreadcrumbRenderer'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { CompositionNetworkHeader } from '@/components/CompositionNetworkHeader'
import { SectionHeading } from '@/components/SectionHeading'
import {
  type CompositionInstance,
  type CompositionPolicy,
  fetchCompositionPolicies,
} from '@/lib/composition/api'
import { APIS } from '@/lib/config'

export const CompositionGovernanceView = ({
  instance,
}: {
  instance: CompositionInstance
}) => {
  const [policies, setPolicies] = useState<CompositionPolicy[]>([])
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setProblem(null)
    try {
      setPolicies(await fetchCompositionPolicies(APIS.ponder, instance.id))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [instance.id])

  return (
    <div className="space-y-10 sm:space-y-12">
      <header className="space-y-6">
        <BreadcrumbRenderer />
        <CompositionNetworkHeader instance={instance} />
      </header>

      <section className="grid gap-px border border-border bg-border sm:grid-cols-3">
        <div className="space-y-1 bg-background p-4">
          <p className="tg-label">Controller</p>
          <p className="break-all font-mono text-xs">
            {instance.controller ?? 'Wallet administered'}
          </p>
        </div>
        <div className="space-y-1 bg-background p-4">
          <p className="tg-label">Current policy</p>
          <p className="text-2xl tabular-nums">v{instance.currentVersion}</p>
        </div>
        <div className="space-y-1 bg-background p-4">
          <p className="tg-label">Admin</p>
          <p className="break-all font-mono text-xs">{instance.admin}</p>
        </div>
      </section>

      <section className="space-y-5" aria-labelledby="policy-history-heading">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <SectionHeading>
              <span id="policy-history-heading">Policy history</span>
            </SectionHeading>
            <p className="mt-2 max-w-3xl text-sm text-text-muted">
              Every pending, activated, cancelled, and superseded source policy
              remains auditable. Changes are managed from Settings.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={load}
            disabled={loading}
          >
            {loading ? (
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Refresh
          </Button>
        </div>

        {problem && (
          <Card type="outline" size="md" className="border-error text-error">
            <p
              role="alert"
              className="break-words text-sm [overflow-wrap:anywhere]"
            >
              {problem}
            </p>
          </Card>
        )}

        <ul className="divide-y divide-border border-y border-border">
          {policies.map((policy) => (
            <li key={policy.id}>
              <Link
                href={`/networks/${instance.id}/policies/${policy.version}`}
                className="grid gap-2 py-4 text-sm hover:bg-surface-2 md:grid-cols-[7rem_1fr_1fr_auto]"
              >
                <span>
                  v{policy.version} · {policy.status}
                </span>
                <span className="truncate font-mono text-xs text-text-muted">
                  manifest {policy.manifestSha256}
                </span>
                <span className="truncate font-mono text-xs text-text-muted">
                  adapters {policy.adapterSetHash}
                </span>
                <span className="text-xs tabular-nums text-text-muted">
                  {policy.readyAt
                    ? new Date(
                        Number(policy.readyAt) * 1000
                      ).toLocaleDateString()
                    : 'landed'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {!loading && policies.length === 0 && !problem && (
          <p className="text-sm text-text-muted">No policy history found.</p>
        )}
      </section>
    </div>
  )
}
