'use client'

import { LoaderCircle, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'

import { TableAddress } from '@/components/Address'
import { BreadcrumbRenderer } from '@/components/BreadcrumbRenderer'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { CompositionNetworkHeader } from '@/components/CompositionNetworkHeader'
import { ScoreUpdateChip } from '@/components/ScoreUpdateChip'
import { SectionHeading } from '@/components/SectionHeading'
import { type Column, Table } from '@/components/Table'
import {
  type CompositionBundle,
  type CompositionEpoch,
  type CompositionInstance,
  fetchCompositionBundle,
  fetchCompositionOverview,
} from '@/lib/composition/api'
import { APIS } from '@/lib/config'
import { formatBigNumber } from '@/lib/utils'

type ScoreRow = CompositionBundle['outputEntries'][number] & { rank: number }

const columns: Column<ScoreRow>[] = [
  {
    key: 'rank',
    header: 'Rank',
    sortable: true,
    accessor: (row) => row.rank,
    render: (row) => `#${row.rank}`,
  },
  {
    key: 'account',
    header: 'Account',
    render: (row) => <TableAddress address={row.account} showNavIcon />,
  },
  {
    key: 'score',
    header: 'Score',
    sortable: true,
    accessor: (row) => BigInt(row.value),
    render: (row) => formatBigNumber(row.value, 18),
    cellClassName: 'text-right tabular-nums',
    headerClassName: 'text-right',
  },
]

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export const CompositionInstanceView = ({
  initialInstance,
}: {
  initialInstance: CompositionInstance
}) => {
  const [instance, setInstance] = useState(initialInstance)
  const [epochs, setEpochs] = useState<CompositionEpoch[]>([])
  const [bundle, setBundle] = useState<CompositionBundle | null>(null)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setProblem(null)
    try {
      const overview = await fetchCompositionOverview(
        APIS.ponder,
        initialInstance.id
      )
      setInstance(overview.instance)
      setEpochs(overview.epochs)
      setBundle(
        overview.epochs[0]
          ? await fetchCompositionBundle(
              APIS.ponder,
              initialInstance.id,
              overview.epochs[0].checkpointId
            )
          : null
      )
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [initialInstance.id])

  const scores: ScoreRow[] = [...(bundle?.outputEntries ?? [])]
    .sort((left, right) =>
      BigInt(left.value) === BigInt(right.value)
        ? left.account.localeCompare(right.account)
        : BigInt(left.value) > BigInt(right.value)
          ? -1
          : 1
    )
    .map((entry, index) => ({ ...entry, rank: index + 1 }))

  return (
    <div className="space-y-10 sm:space-y-12">
      <header className="space-y-6">
        <BreadcrumbRenderer />
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-10">
          <CompositionNetworkHeader instance={instance} description />
          <div className="shrink-0 lg:pt-1">
            <ScoreUpdateChip snapshot={instance.snapshot} />
          </div>
        </div>
      </header>

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

      {(instance.metadata?.criteria?.trim() ||
        instance.metadata?.image?.trim()) && (
        <section className="grid gap-6 border-y border-border py-6 md:grid-cols-2">
          {instance.metadata.criteria?.trim() && (
            <div className="space-y-2">
              <p className="tg-label">What it means to vouch here</p>
              <p className="whitespace-pre-wrap text-sm leading-6 text-text-muted">
                {instance.metadata.criteria.trim()}
              </p>
            </div>
          )}
          {instance.metadata.image?.trim() && (
            <div className="space-y-2">
              <p className="tg-label">Network image</p>
              <a
                href={instance.metadata.image.trim()}
                target="_blank"
                rel="noreferrer"
                className="break-all text-sm underline underline-offset-4"
              >
                View logo or banner
              </a>
            </div>
          )}
        </section>
      )}

      <section className="space-y-5" aria-labelledby="composition-sources">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <SectionHeading>
              <span id="composition-sources">Source mix</span>
            </SectionHeading>
            <p className="mt-2 text-sm text-text-muted">
              The source allocations behind the latest proved scores.
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
        {bundle ? (
          <div className="grid gap-px border border-border bg-border md:grid-cols-2">
            {bundle.sources.map((source) => (
              <div
                key={source.sourceId}
                className="space-y-2 bg-background p-4"
              >
                <p className="font-mono text-xs">
                  {source.sourceId.slice(0, 14)}…{source.sourceId.slice(-8)}
                </p>
                <p className="text-sm tabular-nums text-text-muted">
                  weight {formatBigNumber(source.weight, 18, true)} · quota{' '}
                  {BigInt(source.quota).toLocaleString('en-US')} ·{' '}
                  {source.entryCount.toLocaleString('en-US')} accounts
                </p>
              </div>
            ))}
          </div>
        ) : (
          !loading && (
            <p className="text-sm text-text-muted">
              Source details will appear after the first score proof lands.
            </p>
          )
        )}
      </section>

      <section className="space-y-5" aria-labelledby="network-members">
        <div>
          <SectionHeading>
            <span id="network-members">Network members</span>
          </SectionHeading>
          <p className="mt-2 text-sm text-text-muted">
            {bundle
              ? `Scores proved at checkpoint ${bundle.epoch.checkpointId}.`
              : 'Scores have not been proved yet.'}
          </p>
        </div>
        {scores.length > 0 ? (
          <Table
            columns={columns}
            data={scores}
            getRowKey={(row) => row.account}
            defaultSortColumn="rank"
            defaultSortDirection="asc"
            rowClassName="text-sm"
          />
        ) : (
          !loading && (
            <p className="border-y border-border py-8 text-sm text-text-muted">
              No scored accounts yet.
            </p>
          )
        )}
      </section>

      {epochs.length > 0 && (
        <section className="space-y-4" aria-labelledby="proof-history">
          <SectionHeading>
            <span id="proof-history">Score history</span>
          </SectionHeading>
          <ul className="divide-y divide-border border-y border-border">
            {epochs.slice(0, 8).map((epoch) => {
              const work = asRecord(epoch.work)
              return (
                <li key={epoch.checkpointId}>
                  <Link
                    href={`/networks/${instance.id}/proofs/${epoch.checkpointId}`}
                    className="grid gap-1 py-3 text-sm hover:bg-surface-2 sm:grid-cols-[1fr_auto_auto] sm:gap-6"
                  >
                    <span>Checkpoint {epoch.checkpointId}</span>
                    <span className="text-text-muted">
                      {typeof work.outputAccounts === 'number'
                        ? `${work.outputAccounts.toLocaleString('en-US')} accounts`
                        : `policy v${epoch.policyVersion}`}
                    </span>
                    <span className="tabular-nums text-text-muted">
                      block {epoch.blockNumber}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
