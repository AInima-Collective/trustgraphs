'use client'

import {
  CheckCircle2,
  Download,
  LoaderCircle,
  RefreshCw,
  XCircle,
} from 'lucide-react'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import type { Hex } from 'viem'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { Input } from '@/components/Input'
import {
  type CompositionBundle,
  fetchCompositionBundle,
} from '@/lib/composition/api'
import type { CompositionPreviewAnchor } from '@/lib/composition/workflow'
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

const equal = (left: string | undefined, right: string | undefined) =>
  !!left && !!right && left.toLowerCase() === right.toLowerCase()

export const CompositionEpochView = ({
  instanceId,
  checkpointId,
}: {
  instanceId: Hex
  checkpointId: string
}) => {
  const [bundle, setBundle] = useState<CompositionBundle | null>(null)
  const [preview, setPreview] = useState<CompositionPreviewAnchor | null>(null)
  const [account, setAccount] = useState('')
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setProblem(null)
    try {
      setBundle(
        await fetchCompositionBundle(APIS.ponder, instanceId, checkpointId)
      )
      const remembered = localStorage.getItem(
        `trustgraphs:composition-preview:${instanceId.toLowerCase()}`
      )
      setPreview(remembered ? JSON.parse(remembered) : null)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [checkpointId, instanceId])

  const output = useMemo(
    () =>
      bundle?.outputEntries.find(
        (entry) => entry.account.toLowerCase() === account.toLowerCase()
      ) ?? null,
    [account, bundle]
  )
  const landed = bundle
    ? {
        policyManifestSha256: bundle.policy.manifestSha256,
        captureManifestSha256: bundle.epoch.captureManifestSha256,
        outputRoot: bundle.epoch.root,
        outputBlobSha256: bundle.epoch.outputBlobSha256,
        outputCid: bundle.epoch.outputCid,
      }
    : null
  const parity =
    preview && landed
      ? [
          equal(preview.policyManifestSha256, landed.policyManifestSha256),
          equal(preview.captureManifestSha256, landed.captureManifestSha256),
          equal(preview.outputRoot, landed.outputRoot),
          equal(preview.outputBlobSha256, landed.outputBlobSha256),
          preview.outputCid === landed.outputCid,
        ]
      : null

  return (
    <main
      className="max-w-6xl space-y-6"
      aria-labelledby="composition-epoch-title"
    >
      <header className="space-y-2">
        <Link className="text-sm underline" href={`/networks/${instanceId}`}>
          ← Instance history
        </Link>
        <h1 id="composition-epoch-title" className="text-2xl">
          Composition checkpoint {checkpointId}
        </h1>
        <p className="text-sm text-muted-foreground">
          The cryptographic lane binds exact source states, TGCM capture bytes,
          output bytes/root, and proof program. The governance lane separately
          records controller, policy, adapter set, and activation history.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={load}
          disabled={loading}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh canonical bundle
        </Button>
      </header>
      {loading && (
        <p className="text-sm">
          <LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" />
          Recovering complete bundle…
        </p>
      )}
      {problem && (
        <Card type="outline" size="md">
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        </Card>
      )}
      {bundle && (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <Card type="outline" size="sm">
              <p className="text-xs text-muted-foreground">
                Accepted output root
              </p>
              <p className="break-all font-mono text-xs">{bundle.epoch.root}</p>
            </Card>
            <Card type="outline" size="sm">
              <p className="text-xs text-muted-foreground">Output blob / CID</p>
              <p className="break-all font-mono text-xs">
                {bundle.epoch.outputBlobSha256}
                <br />
                {bundle.epoch.outputCid}
              </p>
            </Card>
            <Card type="outline" size="sm">
              <p className="text-xs text-muted-foreground">
                Policy / parameters
              </p>
              <p className="break-all font-mono text-xs">
                v{bundle.epoch.policyVersion}
                <br />
                {bundle.epoch.paramsHash}
              </p>
            </Card>
          </div>
          <Card type="outline" size="md">
            <h2 className="font-medium">Preview-to-landed commitments</h2>
            {parity ? (
              <p
                className={`mt-2 text-sm ${parity.every(Boolean) ? 'text-emerald-700' : 'text-destructive'}`}
              >
                {parity.every(Boolean) ? (
                  <CheckCircle2 className="mr-2 inline h-4 w-4" />
                ) : (
                  <XCircle className="mr-2 inline h-4 w-4" />
                )}
                {parity.every(Boolean)
                  ? 'The locally reviewed policy, capture, output blob, CID, and root are byte-identical to the landed bundle.'
                  : 'At least one landed commitment differs from the locally reviewed preview. Do not treat this receipt as that preview.'}
              </p>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                No local preview anchor was retained in this browser. The landed
                cross-language commitments remain independently inspectable
                below.
              </p>
            )}
          </Card>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                download(
                  `composition-${instanceId}-${checkpointId}.json`,
                  bundle
                )
              }
            >
              <Download className="mr-2 h-4 w-4" />
              Complete evidence bundle
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                download(
                  `composition-capture-${checkpointId}.json`,
                  bundle.capture
                )
              }
            >
              Exact capture record
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                download(
                  `composition-attribution-${checkpointId}.json`,
                  bundle.attribution
                )
              }
            >
              Attribution rows
            </Button>
          </div>
          <section
            className="space-y-3"
            aria-labelledby="source-evidence-heading"
          >
            <h2 id="source-evidence-heading" className="text-lg font-medium">
              Authenticated source evidence
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Checkpoint / freeze</th>
                    <th>Quota / entries</th>
                    <th>Binding</th>
                  </tr>
                </thead>
                <tbody>
                  {bundle.sources.map((source) => (
                    <tr key={source.sourceId}>
                      <td className="font-mono">
                        {source.sourceId.slice(0, 14)}…
                      </td>
                      <td>
                        {source.sourceCheckpointId} / {source.freezeBlock}
                      </td>
                      <td>
                        {source.quota} / {source.entryCount}
                      </td>
                      <td>
                        {source.cryptographicallyBound &&
                        source.governanceAdmitted
                          ? 'cryptographic + governance'
                          : 'incomplete'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section
            className="space-y-3"
            aria-labelledby="address-proof-heading"
          >
            <h2 id="address-proof-heading" className="text-lg font-medium">
              Address allocation proof
            </h2>
            <p className="text-sm text-muted-foreground">
              Look up one complete output row and its OpenZeppelin-compatible
              Merkle proof against the accepted root.
            </p>
            <Input
              value={account}
              onChange={(event) => setAccount(event.target.value)}
              placeholder="0x… account"
              aria-label="Output account"
            />
            {account && !output && (
              <p className="text-sm">
                No allocation exists for this address in checkpoint{' '}
                {checkpointId}.
              </p>
            )}
            {output && (
              <Card type="outline" size="sm">
                <p className="text-sm">
                  {output.account}: <strong>{output.value}</strong>
                </p>
                <p className="mt-2 break-all font-mono text-xs">
                  proof {JSON.stringify(output.proof)}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    download(`composition-proof-${output.account}.json`, {
                      root: bundle.epoch.root,
                      ...output,
                    })
                  }
                >
                  Download proof
                </Button>
              </Card>
            )}
          </section>
          <div className="grid gap-3 md:grid-cols-2">
            <Card type="outline" size="md">
              <h2 className="font-medium">Cryptographic provenance</h2>
              <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs">
                {JSON.stringify(bundle.provenance.cryptographic, null, 2)}
              </pre>
            </Card>
            <Card type="outline" size="md">
              <h2 className="font-medium">Governance provenance</h2>
              <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs">
                {JSON.stringify(bundle.provenance.governance, null, 2)}
              </pre>
            </Card>
          </div>
        </>
      )}
    </main>
  )
}
