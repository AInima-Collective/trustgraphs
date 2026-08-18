'use client'

import { Download, LoaderCircle } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { Hex } from 'viem'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import {
  type CompositionPolicy,
  fetchCompositionPolicies,
} from '@/lib/composition/api'
import { APIS } from '@/lib/config'

const download = (name: string, value: unknown) => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  )
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

export const CompositionPolicyView = ({
  instanceId,
  version,
}: {
  instanceId: Hex
  version: string
}) => {
  const [policy, setPolicy] = useState<CompositionPolicy | null>(null)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    fetchCompositionPolicies(APIS.ponder, instanceId)
      .then((rows) => {
        const found = rows.find((row) => row.version === version)
        if (!found) throw new Error('Composition policy version not found.')
        setPolicy(found)
      })
      .catch((error) =>
        setProblem(error instanceof Error ? error.message : String(error))
      )
      .finally(() => setLoading(false))
  }, [instanceId, version])

  return (
    <main
      className="max-w-5xl space-y-6"
      aria-labelledby="composition-policy-title"
    >
      <header className="space-y-2">
        <Link
          className="text-sm underline"
          href={`/compositions/${instanceId}`}
        >
          ← Instance history
        </Link>
        <h1 id="composition-policy-title" className="text-2xl">
          Composition policy v{version}
        </h1>
        <p className="text-sm text-muted-foreground">
          A governed source policy receipt. Its weights are enforced inputs, not
          a claim that those choices are wise or objectively correct.
        </p>
      </header>
      {loading && (
        <p className="text-sm">
          <LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />
          Loading policy preimage and lifecycle…
        </p>
      )}
      {problem && (
        <Card type="outline" size="md">
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        </Card>
      )}
      {policy && (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <Card type="outline" size="sm">
              <p className="text-xs text-muted-foreground">Lifecycle</p>
              <p>{policy.status}</p>
              <p className="text-xs">
                proposed{' '}
                {new Date(
                  Number(policy.proposedTimestamp) * 1000
                ).toLocaleString()}
              </p>
            </Card>
            <Card type="outline" size="sm">
              <p className="text-xs text-muted-foreground">
                Manifest / source root
              </p>
              <p className="break-all font-mono text-xs">
                {policy.manifestSha256}
                <br />
                {policy.sourcePolicyRoot}
              </p>
            </Card>
            <Card type="outline" size="sm">
              <p className="text-xs text-muted-foreground">
                Adapter set / metadata
              </p>
              <p className="break-all font-mono text-xs">
                {policy.adapterSetHash}
                <br />
                {policy.metadataDigest}
              </p>
            </Card>
          </div>
          <Card type="outline" size="md">
            <h2 className="font-medium">Exact policy availability</h2>
            <p className="mt-2 text-sm">
              {policy.availability}
              {policy.availabilityError ? `: ${policy.availabilityError}` : ''}.
              Activation is safe only when the exact TGCP manifest and ordered
              adapter preimage are available.
            </p>
            <p className="mt-2 break-all font-mono text-xs">
              TGCP {policy.policyManifest ?? 'unavailable'}
            </p>
          </Card>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                download(
                  `composition-policy-${instanceId}-v${version}.json`,
                  policy
                )
              }
            >
              <Download className="mr-2 h-4 w-4" />
              Policy receipt
            </Button>
            {policy.policyManifest && (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  download(`composition-policy-v${version}-preimage.json`, {
                    manifest: policy.policyManifest,
                    adapters: policy.adapters,
                  })
                }
              >
                Activation preimage
              </Button>
            )}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Card type="outline" size="md">
              <h2 className="font-medium">Cryptographic commitment</h2>
              <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs">
                {JSON.stringify(policy.provenance.cryptographic, null, 2)}
              </pre>
            </Card>
            <Card type="outline" size="md">
              <h2 className="font-medium">Governance receipt</h2>
              <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs">
                {JSON.stringify(policy.provenance.governance, null, 2)}
              </pre>
            </Card>
          </div>
        </>
      )}
    </main>
  )
}
