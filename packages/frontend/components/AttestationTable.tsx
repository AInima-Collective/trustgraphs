'use client'

import { ArrowRight, ArrowUpRight } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo } from 'react'

import { useNetworks } from '@/contexts/CatalogContext'
import { usePushBreadcrumb } from '@/hooks/usePushBreadcrumb'
import { AttestationData, AttestationStatus } from '@/lib/attestation'
import { Network } from '@/lib/types'
import { cn, formatBigNumber } from '@/lib/utils'

import { Address, TableAddress } from './Address'
import { Column, Table } from './Table'
import { Tooltip } from './Tooltip'

/** `{ lowercased schema uid -> network }`. */
export type SchemaToNetwork = Record<string, Network>

/**
 * Which network each attestation was made in, from the runtime catalog, so a
 * network created since the last deploy is still named.
 */
export const useSchemaToNetwork = (): SchemaToNetwork => {
  const networks = useNetworks()
  return useMemo(() => {
    const map: SchemaToNetwork = {}
    for (const network of networks) {
      for (const schema of network.schemas) {
        map[schema.uid.toLowerCase()] = network
      }
    }
    return map
  }, [networks])
}

export const attestationComment = (row: AttestationData) =>
  typeof row.decodedData?.comment === 'string'
    ? row.decodedData.comment.trim()
    : ''

export const attestationConfidence = (row: AttestationData) =>
  Number(row.decodedData?.confidence || '0')

/** Revoked and expired get a badge; an attestation in force needs none. */
export function AttestationStatusBadge({
  status,
  className,
}: {
  status: AttestationData['status']
  className?: string
}) {
  if (status === AttestationStatus.VERIFIED) {
    return null
  }
  return (
    <span
      className={cn(
        'inline-flex border px-2 py-0.5 text-[10px] uppercase tracking-wider',
        status === AttestationStatus.REVOKED
          ? 'border-error/40 text-error'
          : 'border-warn/40 text-warn',
        className
      )}
    >
      {status}
    </span>
  )
}

type PushBreadcrumb = ReturnType<typeof usePushBreadcrumb>

export type AttestationTableProps = {
  rows: AttestationData[]
  /**
   * Who to list: one side, when the page is already about the other, or both
   * as "from → to".
   */
  parties: 'attester' | 'recipient' | 'both'
  /** Name each row's network; off when every row is in the same one. */
  showNetwork: boolean
  schemaToNetwork: SchemaToNetwork
  pushBreadcrumb: PushBreadcrumb
}

/**
 * Attestations as a table from `md` up and a list below it, the same split as
 * the network page's members, rather than a table scrolled sideways on a phone.
 * Rows open the attestation.
 */
export function AttestationTable({
  rows,
  parties,
  showNetwork,
  schemaToNetwork,
  pushBreadcrumb,
}: AttestationTableProps) {
  const router = useRouter()
  const columns = attestationColumns({
    parties,
    showNetwork,
    showStatus: rows.some((row) => row.status !== AttestationStatus.VERIFIED),
    schemaToNetwork,
    pushBreadcrumb,
  })

  return (
    <>
      <ul className="list-none divide-y divide-border border-y border-border pl-0 md:hidden">
        {[...rows]
          .sort((a, b) => Number(b.time - a.time))
          .map((row) => {
            const comment = attestationComment(row)
            const network = schemaToNetwork[row.schema.toLowerCase()]
            return (
              <li
                key={row.uid}
                className={cn(
                  'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 py-3',
                  row.status !== AttestationStatus.VERIFIED && 'opacity-70'
                )}
              >
                <div className="min-w-0 space-y-1">
                  {parties === 'both' ? (
                    <Parties row={row} />
                  ) : (
                    <Address
                      address={row[parties]}
                      showCopyIcon={false}
                      showNavIcon
                    />
                  )}
                  <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-text-muted">
                    {showNetwork && network && <span>{network.name} ·</span>}
                    <span>{row.formattedTimeAgo}</span>
                    <AttestationStatusBadge status={row.status} />
                  </p>
                  {comment && (
                    <p className="line-clamp-2 text-xs text-text">{comment}</p>
                  )}
                </div>
                <Link
                  href={`/attestations/${row.uid}`}
                  onClick={() => pushBreadcrumb()}
                  aria-label={`View attestation from ${row.formattedTime}`}
                  className="tg-touch-target inline-flex flex-col items-end text-right focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                >
                  <span className="text-sm tabular-nums text-text">
                    {formatBigNumber(
                      attestationConfidence(row),
                      undefined,
                      true
                    )}
                  </span>
                  <span className="text-[9px] uppercase tracking-wider text-text-subtle">
                    Confidence
                  </span>
                </Link>
              </li>
            )
          })}
      </ul>
      <Table
        className="hidden md:block"
        columns={columns}
        data={rows}
        rowClassName={(row) =>
          cn(
            'text-sm',
            row.status !== AttestationStatus.VERIFIED && 'opacity-70'
          )
        }
        defaultSortColumn="time"
        defaultSortDirection="desc"
        onRowClick={(row) => {
          pushBreadcrumb()
          router.push(`/attestations/${row.uid}`)
        }}
        getRowKey={(row) => row.uid}
      />
    </>
  )
}

/** "attester → recipient", each a link to its account. */
function Parties({ row }: { row: AttestationData }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2">
      <Address
        address={row.attester}
        displayMode="compact"
        showCopyIcon={false}
        noHighlightEns
      />
      <ArrowRight
        aria-label="to"
        className="h-3 w-3 shrink-0 text-text-subtle"
      />
      <Address
        address={row.recipient}
        displayMode="compact"
        showCopyIcon={false}
        noHighlightEns
      />
    </span>
  )
}

const attestationColumns = ({
  parties,
  showNetwork,
  showStatus,
  schemaToNetwork,
  pushBreadcrumb,
}: {
  parties: AttestationTableProps['parties']
  showNetwork: boolean
  showStatus: boolean
  schemaToNetwork: SchemaToNetwork
  pushBreadcrumb: PushBreadcrumb
}): Column<AttestationData>[] => [
  parties === 'both'
    ? {
        key: 'parties',
        header: 'FROM → TO',
        tooltip:
          'The account that made the attestation, and the one it is for.',
        sortable: false,
        render: (row) => <Parties row={row} />,
      }
    : parties === 'attester'
      ? {
          key: 'attester',
          header: 'ATTESTER',
          tooltip: 'The account that made the attestation.',
          sortable: false,
          render: (row) => <TableAddress address={row.attester} showNavIcon />,
        }
      : {
          key: 'recipient',
          header: 'RECIPIENT',
          tooltip: 'The account that received the attestation.',
          sortable: false,
          render: (row) => <TableAddress address={row.recipient} showNavIcon />,
        },
  ...(showNetwork
    ? [
        {
          key: 'network',
          header: 'NETWORK',
          tooltip: 'The network this attestation was made in.',
          sortable: false,
          render: (row: AttestationData) => {
            const network = schemaToNetwork[row.schema.toLowerCase()]
            if (!network) {
              return <span className="text-text-subtle text-sm">—</span>
            }
            return (
              <Link
                className="group/network inline-flex items-center gap-2 transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  pushBreadcrumb()
                }}
                href={`/networks/${network.id}`}
              >
                <span className="text-sm text-text-muted transition-colors group-hover/network:text-text">
                  {network.name}
                </span>
                <ArrowUpRight className="h-3 w-3 shrink-0 text-text-muted transition-colors group-hover/network:text-text" />
              </Link>
            )
          },
        },
      ]
    : []),
  {
    key: 'confidence',
    header: 'CONFIDENCE',
    tooltip: 'The strength of the attestation as specified by the attester.',
    sortable: true,
    accessor: attestationConfidence,
    render: (row) =>
      formatBigNumber(attestationConfidence(row), undefined, true),
  },
  {
    key: 'comment',
    header: 'COMMENT',
    tooltip: 'An optional comment from the attester.',
    sortable: false,
    render: (row) => {
      const comment = attestationComment(row)
      return comment ? (
        <Tooltip title={comment}>
          <span className="block max-w-[32ch] truncate text-left text-text-muted">
            {comment}
          </span>
        </Tooltip>
      ) : (
        <span className="text-text-subtle">—</span>
      )
    },
  },
  ...(showStatus
    ? [
        {
          key: 'status',
          header: 'STATUS',
          tooltip: 'Revoked by the attester, or past its expiry.',
          sortable: false,
          render: (row: AttestationData) => (
            <AttestationStatusBadge status={row.status} />
          ),
        },
      ]
    : []),
  {
    key: 'time',
    header: 'TIME',
    tooltip: 'The time the attestation was made.',
    sortable: true,
    accessor: (row) => Number(row.time),
    render: (row) => (
      <Link
        href={`/attestations/${row.uid}`}
        onClick={() => pushBreadcrumb()}
        className="tg-touch-target inline-flex flex-col justify-center text-sm text-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        aria-label={`View attestation from ${row.formattedTime}`}
      >
        <span>{row.formattedTime}</span>
        <span className="text-xs text-text-muted">{row.formattedTimeAgo}</span>
      </Link>
    ),
  },
]
