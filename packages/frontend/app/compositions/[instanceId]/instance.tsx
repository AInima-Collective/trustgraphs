'use client'

import { LoaderCircle, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { Hex } from 'viem'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import {
  type CompositionEpoch,
  type CompositionInstance,
  type CompositionPolicy,
  fetchCompositionOverview,
} from '@/lib/composition/api'
import { APIS } from '@/lib/config'

export const CompositionInstanceView = ({
  instanceId,
}: {
  instanceId: Hex
}) => {
  const [instance, setInstance] = useState<CompositionInstance | null>(null)
  const [policies, setPolicies] = useState<CompositionPolicy[]>([])
  const [epochs, setEpochs] = useState<CompositionEpoch[]>([])
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setProblem(null)
    try {
      const overview = await fetchCompositionOverview(APIS.ponder, instanceId)
      setInstance(overview.instance)
      setPolicies(overview.policies)
      setEpochs(overview.epochs)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [instanceId])

  return (
    <main
      className="max-w-6xl space-y-6"
      aria-labelledby="composition-instance-title"
    >
      <header className="space-y-2">
        <Link className="text-sm underline" href="/compositions">
          ← All compositions
        </Link>
        <h1 id="composition-instance-title" className="text-2xl">
          {instance?.name ?? 'Composition instance'}
        </h1>
        <p className="break-all font-mono text-xs">{instanceId}</p>
        <Button
          type="button"
          variant="outline"
          onClick={load}
          disabled={loading}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh after confirmations/reorgs
        </Button>
      </header>
      {loading && (
        <p className="text-sm">
          <LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />
          Loading canonical receipts…
        </p>
      )}
      {problem && (
        <Card type="outline" size="md">
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        </Card>
      )}
      {instance && (
        <div className="grid gap-3 md:grid-cols-3">
          <Card type="outline" size="sm">
            <p className="text-xs text-muted-foreground">Controller / admin</p>
            <p className="break-all font-mono text-xs">
              {instance.controller}
              <br />
              {instance.admin}
            </p>
          </Card>
          <Card type="outline" size="sm">
            <p className="text-xs text-muted-foreground">Current params</p>
            <p className="break-all font-mono text-xs">
              v{instance.currentVersion}
              <br />
              {instance.currentParamsHash}
            </p>
          </Card>
          <Card type="outline" size="sm">
            <p className="text-xs text-muted-foreground">Schedule</p>
            <p className="text-sm">
              {instance.epochLength} blocks · snapshot{' '}
              <span className="font-mono">
                {instance.snapshot.slice(0, 10)}…
              </span>
            </p>
          </Card>
        </div>
      )}

      <section className="space-y-3" aria-labelledby="policy-history-heading">
        <h2 id="policy-history-heading" className="text-lg font-medium">
          Governed policy history
        </h2>
        <p className="text-sm text-muted-foreground">
          Pending, cancelled, activated, and superseded versions remain visible;
          version gaps are not reused.
        </p>
        <div className="space-y-2">
          {policies.map((policy) => (
            <Link
              key={policy.id}
              href={`/compositions/${instanceId}/policies/${policy.version}`}
            >
              <Card
                type="outline"
                size="sm"
                className="grid gap-2 md:grid-cols-4"
              >
                <p>
                  v{policy.version} · <strong>{policy.status}</strong>
                </p>
                <p className="font-mono text-xs">
                  manifest {policy.manifestSha256.slice(0, 14)}…
                </p>
                <p className="font-mono text-xs">
                  adapter set {policy.adapterSetHash.slice(0, 14)}…
                </p>
                <p className="text-xs">
                  {policy.readyAt
                    ? `ready ${new Date(Number(policy.readyAt) * 1000).toLocaleString()}`
                    : 'landed'}
                </p>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="epoch-history-heading">
        <h2 id="epoch-history-heading" className="text-lg font-medium">
          Proved epoch history
        </h2>
        <p className="text-sm text-muted-foreground">
          Each route recovers exact TGCM capture bytes, source and controller
          provenance, complete attribution, canonical output entries, and
          address proofs.
        </p>
        <div className="space-y-2">
          {epochs.map((epoch) => (
            <Link
              key={epoch.checkpointId}
              href={`/compositions/${instanceId}/epochs/${epoch.checkpointId}`}
            >
              <Card
                type="outline"
                size="sm"
                className="grid gap-2 md:grid-cols-4"
              >
                <p>checkpoint {epoch.checkpointId}</p>
                <p>policy v{epoch.policyVersion}</p>
                <p className="font-mono text-xs">
                  root {epoch.root.slice(0, 14)}…
                </p>
                <p className="text-xs">block {epoch.blockNumber}</p>
              </Card>
            </Link>
          ))}
        </div>
        {!loading && epochs.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No composition proof has landed yet.
          </p>
        )}
      </section>
    </main>
  )
}
