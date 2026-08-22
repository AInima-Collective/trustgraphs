import Link from 'next/link'
import { notFound } from 'next/navigation'
import { isAddress } from 'viem'

import { APIS } from '@/lib/config'
import { fetchNostrWorkspaceScorePage } from '@/lib/nostr-workspace/api'
import { formatBigNumber } from '@/lib/utils'

const short = (value: string) => `${value.slice(0, 10)}…${value.slice(-6)}`

export default async function NostrWorkspaceInstancePage({
  params,
  searchParams,
}: {
  params: Promise<{ snapshot: string }>
  searchParams: Promise<{ offset?: string }>
}) {
  const { snapshot } = await params
  if (!isAddress(snapshot, { strict: false })) notFound()
  const rawOffset = (await searchParams).offset ?? '0'
  if (!/^(0|[1-9][0-9]*)$/.test(rawOffset)) notFound()
  const offset = Number(rawOffset)
  if (!Number.isSafeInteger(offset)) notFound()

  let epoch
  try {
    epoch = await fetchNostrWorkspaceScorePage(APIS.ponder, snapshot, {
      limit: 50,
      offset,
    })
  } catch (error) {
    return (
      <main className="mx-auto max-w-6xl space-y-6 px-5 py-10">
        <h1 className="text-2xl font-bold">Nostr workspace unavailable</h1>
        <p className="border border-error/40 p-4 text-sm text-error">
          {error instanceof Error ? error.message : String(error)}
        </p>
      </main>
    )
  }

  const skips = Object.entries(epoch.skipSummary)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(', ')
  const previous = Math.max(0, offset - epoch.page.limit)
  const next = offset + epoch.page.limit

  return (
    <main className="mx-auto max-w-6xl space-y-10 px-5 py-10">
      <header className="space-y-3">
        <p className="font-mono text-xs text-text-muted">{epoch.snapshot}</p>
        <h1 className="text-2xl font-bold">Nostr workspace scores</h1>
        <p className="max-w-3xl text-sm text-text-muted">
          Proof-backed member and delegated-agent scores for checkpoint{' '}
          {epoch.checkpointId}. Event bodies remain in the archive access scope
          and are never returned by this view.
        </p>
      </header>

      <dl className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Epoch trust', epoch.epochTrustClass],
          ['Archive access', epoch.accessPolicy],
          ['Reduced recompute', epoch.reducedRecomputeStatus],
          ['Anchored heads', epoch.anchorCount],
          ['Scored actors', String(epoch.numNodes)],
          ['Total score', formatBigNumber(epoch.totalValue, 18)],
          ['Skip reasons', skips || 'none'],
          ['Output root', short(epoch.root)],
        ].map(([label, view]) => (
          <div key={label} className="min-w-0 bg-background p-4">
            <dt className="text-xs uppercase text-text-muted">{label}</dt>
            <dd className="mt-2 break-words text-sm" title={view}>
              {view}
            </dd>
          </div>
        ))}
      </dl>

      <section className="space-y-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Members and agents</h2>
            <p className="text-xs text-text-muted">
              Every row includes a Merkle proof checked against the
              authenticated root before rendering.
            </p>
          </div>
          <p className="text-xs text-text-muted">
            {offset + 1}–{Math.min(next, epoch.page.total)} of{' '}
            {epoch.page.total}
          </p>
        </div>
        <div className="overflow-x-auto border border-border">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="border-b border-border text-xs uppercase text-text-muted">
              <tr>
                <th className="p-3">Actor</th>
                <th className="p-3">Nostr public key</th>
                <th className="p-3">Owner provenance</th>
                <th className="p-3">EVM binding</th>
                <th className="p-3 text-right">Score</th>
                <th className="p-3 text-right">Proof</th>
              </tr>
            </thead>
            <tbody>
              {epoch.scores.map((score) => (
                <tr
                  key={score.nodeId}
                  className="border-b border-border last:border-0"
                >
                  <td className="p-3">
                    <span className="uppercase">{score.actorKind}</span>
                    <span
                      className="block font-mono text-xs text-text-muted"
                      title={score.nodeId}
                    >
                      {short(score.nodeId)}
                    </span>
                  </td>
                  <td className="p-3 font-mono" title={score.nostrPubkey}>
                    {short(score.nostrPubkey)}
                  </td>
                  <td
                    className="p-3 font-mono"
                    title={score.ownerNodeId ?? undefined}
                  >
                    {score.ownerNodeId ? short(score.ownerNodeId) : '—'}
                  </td>
                  <td
                    className="p-3 font-mono"
                    title={score.boundAddress ?? undefined}
                  >
                    {score.boundAddress ? short(score.boundAddress) : '—'}
                  </td>
                  <td className="p-3 text-right tabular-nums">
                    {formatBigNumber(score.value, 18)}
                  </td>
                  <td
                    className="p-3 text-right tabular-nums"
                    title={score.proof.join('\n')}
                  >
                    {score.proof.length} hashes
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {epoch.scores.length === 0 && (
          <p className="text-sm text-text-muted">No scores in this page.</p>
        )}
        <nav className="flex justify-between text-sm" aria-label="Score pages">
          {offset > 0 ? (
            <Link className="underline" href={`?offset=${previous}`}>
              Previous
            </Link>
          ) : (
            <span />
          )}
          {next < epoch.page.total && (
            <Link className="underline" href={`?offset=${next}`}>
              Next
            </Link>
          )}
        </nav>
      </section>

      <footer className="border-t border-border pt-5 text-xs text-text-muted">
        Program {epoch.scoreProgram.programName} · output domain{' '}
        {epoch.scoreProgram.outputDomainName} · score blob {epoch.ipfsHashCid}
      </footer>
    </main>
  )
}
