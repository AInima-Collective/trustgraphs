'use client'

import { LoaderCircle, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { APIS, GRAPH_LINEAGE_CONFIG } from '@/lib/config'
import {
  type GraphLineage,
  GraphLineageApiUnavailableError,
  fetchGraphLineages,
} from '@/lib/graph-lineage'

export const GraphLineageCatalog = () => {
  const [lineages, setLineages] = useState<GraphLineage[]>([])
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setProblem(null)
    try {
      setLineages(await fetchGraphLineages(APIS.ponder))
    } catch (error) {
      setProblem(
        error instanceof GraphLineageApiUnavailableError
          ? 'Graph-lineage indexing is not deployed on this rolling release yet.'
          : error instanceof Error
            ? error.message
            : String(error)
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <main className="max-w-5xl space-y-6" aria-labelledby="lineages-title">
      <header className="space-y-2">
        <h1 id="lineages-title" className="text-2xl">
          Graph lineage provenance
        </h1>
        <p className="text-sm text-muted-foreground">
          A lineage is an authenticated, continuing graph actor. A Merkle root
          is one epoch—not an actor and not an endorsement signer. Every claim
          below is scoped, expiring, version-pinned, and advisory only.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={load}
            disabled={loading}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh authenticated history
          </Button>
          <Link
            className="rounded border px-3 py-2 text-sm"
            href="/compositions"
          >
            Composition provenance
          </Link>
          <Link
            className="rounded border px-3 py-2 text-sm"
            href="/graph-reputation"
          >
            Advisory recommendations
          </Link>
        </div>
      </header>

      {!GRAPH_LINEAGE_CONFIG?.registry && (
        <Card type="outline" size="md">
          <p className="text-sm">
            This frontend has no graph-lineage registry configured. Existing
            score, proof, and composition routes are unaffected.
          </p>
        </Card>
      )}
      {problem && (
        <Card type="outline" size="md">
          <p role="alert" className="text-sm">
            {problem} Existing score/root/proof behavior is unchanged.
          </p>
        </Card>
      )}
      {loading && (
        <p className="text-sm">
          <LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />
          Loading qualified identities…
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {lineages.map((lineage) => (
          <Link key={lineage.id} href={`/graph-lineages/${lineage.id}`}>
            <Card
              type="outline"
              size="md"
              className="h-full space-y-2 hover:border-foreground"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-medium">{lineage.displayName}</h2>
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
                    lineage.authenticatedLive
                      ? 'bg-emerald-100 text-emerald-900'
                      : 'bg-amber-100 text-amber-900'
                  }`}
                >
                  {lineage.authenticatedLive ? 'live' : 'suspended'}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                chain {lineage.chainId} · configuration v
                {lineage.currentVersion}
              </p>
              <p className="break-all font-mono text-xs">{lineage.id}</p>
              <p className="break-all font-mono text-xs">
                family {lineage.familyId}
              </p>
              <p className="text-xs">
                authority {lineage.authority.slice(0, 10)}… · controller{' '}
                {lineage.controller.slice(0, 10)}…
              </p>
            </Card>
          </Link>
        ))}
      </div>
      {!loading && !problem && lineages.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No authenticated graph lineage has been indexed yet.
        </p>
      )}
    </main>
  )
}
