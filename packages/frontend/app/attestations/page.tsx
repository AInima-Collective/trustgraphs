'use client'

import { ListFilter } from 'lucide-react'
import { useState } from 'react'
import { Hex } from 'viem'

import {
  AttestationTable,
  useSchemaToNetwork,
} from '@/components/AttestationTable'
import { Dropdown } from '@/components/Dropdown'
import { PageTitle, SectionHeading } from '@/components/SectionHeading'
import { useNetworks } from '@/contexts/CatalogContext'
import { useIntoAttestationsData } from '@/hooks/useAttestation'
import { usePushBreadcrumb } from '@/hooks/usePushBreadcrumb'
import { applicationEnvironmentLabel } from '@/lib/application-chains'
import { AttestationStatus } from '@/lib/attestation'
import { CHAIN } from '@/lib/config'
import { parseErrorMessage } from '@/lib/error'
import { usePonderQuery } from '@/lib/use-ponder-query'
import { formatBigNumber } from '@/lib/utils'
import { ponderQueryFns } from '@/queries/ponder'

/** The newest this many. Older ones stay reachable from their accounts and networks. */
const LIMIT = 500

type StatusFilter = 'all' | `${AttestationStatus}`

export default function AttestationsPage() {
  const pushBreadcrumb = usePushBreadcrumb()
  const networks = useNetworks()
  const schemaToNetwork = useSchemaToNetwork()
  const [networkId, setNetworkId] = useState('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const network = networks.find((network) => network.id === networkId)

  const { data: [{ count: total }] = [{ count: 0 }] } = usePonderQuery({
    queryFn: ponderQueryFns.getAttestationCount,
  })

  const {
    data: attestations = [],
    isLoading,
    error,
  } = usePonderQuery({
    queryFn: ponderQueryFns.getAttestations({
      // A network may have more than one schema; filtering in the query rather than on the page
      // keeps the newest LIMIT of that network, not its share of everyone's newest LIMIT.
      schemas: network?.schemas.map((schema) => schema.uid as Hex),
      includeRevoked: true,
      includeSelfAttests: true,
      order: 'desc',
      limit: LIMIT,
    }),
    select: useIntoAttestationsData(),
  })

  const rows = attestations.filter(
    (attestation) => status === 'all' || attestation.status === status
  )
  const capped = !network && attestations.length === LIMIT && total > LIMIT

  return (
    <div className="space-y-10 sm:space-y-12">
      <header className="flex flex-col items-start gap-3">
        <PageTitle>Attestations</PageTitle>
        <p className="max-w-2xl text-sm text-text-muted">
          Every attestation made in a network on{' '}
          {applicationEnvironmentLabel(CHAIN)}, newest first. Each one is one
          account vouching for another, recorded on-chain with EAS.
        </p>
      </header>

      <section aria-label="Attestations" className="space-y-6">
        <div className="flex flex-row flex-wrap items-center justify-between gap-x-8 gap-y-4">
          <div className="flex flex-col gap-1">
            <SectionHeading>{network?.name ?? 'All networks'}</SectionHeading>
            <p className="text-xs text-text-muted">
              {isLoading
                ? 'Loading…'
                : `${formatBigNumber(rows.length, undefined, true)} ${
                    rows.length === 1 ? 'attestation' : 'attestations'
                  }${
                    capped
                      ? `, the newest of ${formatBigNumber(total, undefined, true)}`
                      : ''
                  }`}
            </p>
          </div>

          <div className="flex flex-row flex-wrap items-stretch gap-2">
            {networks.length > 1 && (
              <Dropdown
                label="Filter by network"
                options={[
                  { value: 'all', label: 'ALL NETWORKS' },
                  ...networks.map((network) => ({
                    value: network.id,
                    label: network.name.toUpperCase(),
                  })),
                ]}
                selected={networkId}
                onSelect={setNetworkId}
                triggerSize="sm"
                triggerClassName="text-xs"
                optionClassName="text-xs"
              />
            )}
            <Dropdown<StatusFilter>
              label="Filter by status"
              options={[
                { value: 'all', label: 'ALL STATUSES' },
                { value: AttestationStatus.VERIFIED, label: 'ACTIVE' },
                { value: AttestationStatus.REVOKED, label: 'REVOKED' },
                { value: AttestationStatus.EXPIRED, label: 'EXPIRED' },
              ]}
              selected={status}
              onSelect={setStatus}
              icon={<ListFilter className="!w-4 !h-4" />}
              triggerSize="sm"
              triggerClassName="text-xs"
              optionClassName="text-xs"
            />
          </div>
        </div>

        {error ? (
          <div className="border border-error bg-error-soft p-4 rounded-sm">
            <div className="error-text text-sm text-error">
              ⚠️ {parseErrorMessage(error)}
            </div>
          </div>
        ) : isLoading ? (
          <div className="text-center py-8">
            <div className="text-sm text-text">◉ LOADING ATTESTATIONS ◉</div>
            <div className="text-xs mt-2 text-text-muted">
              Fetching the newest attestations...
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="border border-border bg-surface py-8 text-center">
            <div className="text-sm text-text-muted">NO ATTESTATIONS FOUND</div>
            {(status !== 'all' || network) && (
              <div className="text-xs mt-2 text-text-muted">
                TRY ADJUSTING YOUR FILTER SETTINGS
              </div>
            )}
          </div>
        ) : (
          <AttestationTable
            rows={rows}
            parties="both"
            showNetwork={!network}
            schemaToNetwork={schemaToNetwork}
            pushBreadcrumb={pushBreadcrumb}
          />
        )}
      </section>
    </div>
  )
}
