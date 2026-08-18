'use client'

import { LoaderCircle, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import {
  CompositionApiUnavailableError,
  type CompositionInstance,
  fetchCompositionInstances,
} from '@/lib/composition/api'
import { APIS } from '@/lib/config'

export const CompositionCatalog = () => {
  const [instances, setInstances] = useState<CompositionInstance[]>([])
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setProblem(null)
    try {
      setInstances(await fetchCompositionInstances(APIS.ponder))
    } catch (error) {
      setProblem(
        error instanceof CompositionApiUnavailableError
          ? 'Composition indexing is not deployed on this rolling release yet.'
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
    <main className="max-w-5xl space-y-6" aria-labelledby="compositions-title">
      <header className="space-y-2">
        <h1 id="compositions-title" className="text-2xl">
          Composition provenance
        </h1>
        <p className="text-sm text-muted-foreground">
          Durable policy, capture, output, proof, and governance receipts for
          trust-compose instances. These are proved final-distribution
          blends—not raw-edge unions or inherited priors.
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={load}
            disabled={loading}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh canonical history
          </Button>
          <Link
            className="rounded border px-3 py-2 text-sm"
            href="/create/composition"
          >
            Open composition workspace
          </Link>
        </div>
      </header>
      {problem && (
        <Card type="outline" size="md">
          <p role="alert" className="text-sm">
            {problem} Existing TrustGraph pages remain available.
          </p>
        </Card>
      )}
      {loading && (
        <p className="text-sm">
          <LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />
          Loading indexed composition history…
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {instances.map((instance) => (
          <Link key={instance.id} href={`/compositions/${instance.id}`}>
            <Card
              type="outline"
              size="md"
              className="h-full space-y-2 hover:border-foreground"
            >
              <h2 className="font-medium">{instance.name}</h2>
              <p className="text-xs text-muted-foreground">
                chain {instance.chainId} · current policy v
                {instance.currentVersion} · epoch {instance.epochLength} blocks
              </p>
              <p className="break-all font-mono text-xs">{instance.id}</p>
              <p className="text-xs">
                created{' '}
                {new Date(
                  Number(instance.createdTimestamp) * 1000
                ).toLocaleString()}
              </p>
            </Card>
          </Link>
        ))}
      </div>
      {!loading && !problem && instances.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No composition instance has been indexed yet.
        </p>
      )}
    </main>
  )
}
