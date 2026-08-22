'use client'

import { Hex } from 'viem'

import { useAttestation } from '@/hooks/useAttestation'
import { formatTimeAgo } from '@/lib/utils'

import { Address } from './Address'
import { AttestationDataDisplay } from './AttestationData'
import { Card } from './Card'
import { CopyableText } from './CopyableText'

interface AttestationCardProps {
  uid: Hex
  onClick?: () => void
}

export function AttestationCard({ uid, onClick }: AttestationCardProps) {
  const {
    query: { data: attestation, isLoading, error },
  } = useAttestation(uid)

  const formatTimestamp = (timestamp: number) => {
    // Validate timestamp is a valid number
    if (!timestamp || isNaN(timestamp) || timestamp < 0) {
      return 'Invalid timestamp'
    }

    const date = new Date(timestamp * 1000)

    // Check if the date is valid
    if (isNaN(date.getTime())) {
      return 'Invalid date'
    }

    return date.toISOString().replace('T', ' ').split('.')[0]
  }

  // const getAttestationStatus = (attestation: AttestationData) => {
  //   if (Number(attestation.revocationTime) > 0) {
  //     return {
  //       status: 'revoked',
  //       color: 'text-error bg-error-soft border-error',
  //     }
  //   }
  //   if (
  //     Number(attestation.expirationTime) > 0 &&
  //     Number(attestation.expirationTime) < Math.floor(Date.now() / 1000)
  //   ) {
  //     return {
  //       status: 'expired',
  //       color: 'text-warn bg-warn-soft border-warn',
  //     }
  //   }
  //   return {
  //     status: 'verified',
  //     color: 'text-success bg-success-soft border-success',
  //   }
  // }

  if (isLoading) {
    return (
      <Card type="primary" size="lg">
        <div className="space-y-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center space-x-3">
              <span className="text-muted-foreground text-lg">◆</span>
              <div>
                <h3 className="font-semibold text-base">Attestation</h3>
                <div className="text-muted-foreground text-sm">Loading...</div>
              </div>
            </div>
            <div className="text-muted-foreground text-xs">Loading</div>
          </div>
          <div className="text-muted-foreground text-xs font-mono">
            UID: {uid}
          </div>
          <div className="text-muted-foreground text-sm">
            Fetching attestation details from EAS contract...
          </div>
        </div>
      </Card>
    )
  }

  if (error) {
    return (
      <Card
        type="primary"
        size="lg"
        className="border-destructive/50 bg-destructive/10"
      >
        <div className="space-y-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center space-x-3">
              <span className="text-destructive text-lg">◆</span>
              <div>
                <h3 className="font-semibold text-base">Attestation</h3>
                <div className="text-muted-foreground text-sm">
                  Failed to load
                </div>
              </div>
            </div>
            <div className="text-destructive text-xs font-medium">Error</div>
          </div>
          <div className="text-muted-foreground text-xs font-mono">
            UID: {uid}
          </div>
          <div className="text-destructive text-sm">
            Failed to load attestation: {error.message}
          </div>
        </div>
      </Card>
    )
  }

  if (!attestation) {
    return (
      <Card type="primary" size="lg" className="border-warn bg-warn-soft">
        <div className="space-y-4">
          <div className="flex items-start justify-between">
            <div className="flex items-center space-x-3">
              <div>
                <h3 className="font-semibold text-base">Attestation</h3>
                <div className="text-muted-foreground text-sm">
                  No data found
                </div>
              </div>
            </div>
            <div className="text-warn text-xs font-medium">Not Found</div>
          </div>
          <div className="text-muted-foreground text-xs font-mono">
            UID: {uid}
          </div>
          <div className="text-muted-foreground text-sm">
            Attestation not found or invalid UID
          </div>
        </div>
      </Card>
    )
  }

  // const statusInfo = getAttestationStatus(attestation)
  // const schemaName =
  //   SchemaManager.maybeSchemaForUid(attestation.schema)?.name || 'Unknown'

  return (
    <Card
      type="primary"
      size="lg"
      className={
        onClick
          ? 'cursor-pointer hover:border-foreground/50 transition-colors'
          : ''
      }
      onClick={onClick}
    >
      <div className="flex flex-col gap-4">
        {/* Header */}
        {/* <div className="flex items-start justify-between">
          <div className="flex items-center space-x-3">
            <h3 className="font-semibold text-base">{schemaName}</h3>
          </div>
          <div className="flex items-center gap-2">
            {statusInfo.status !== 'verified' && (
              <div
                className={`px-3 py-1 border rounded-md text-xs font-medium ${statusInfo.color}`}
              >
                {statusInfo.status.charAt(0).toUpperCase() +
                  statusInfo.status.slice(1)}
              </div>
            )}
            {canRevoke && (
              <Button
                size="xs"
                variant="destructive"
                onClick={handleRevoke}
                disabled={isRevokingThis}
              >
                {isRevokingThis ? 'Revoking...' : 'Revoke'}
              </Button>
            )}
          </div>
        </div> */}

        {/* Attestation Details Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-muted-foreground text-sm font-medium mb-1">
              UID
            </div>
            <CopyableText text={uid} className="text-foreground" />
          </div>
          <div>
            <div className="text-muted-foreground text-sm font-medium mb-1">
              Timestamp
            </div>
            <div className="text-foreground text-xs">
              {formatTimestamp(Number(attestation.time))} (
              {formatTimeAgo(Number(attestation.time) * 1e3)})
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-sm font-medium mb-1">
              Attester
            </div>
            <Address
              address={attestation.attester}
              textClassName="text-foreground text-xs"
              displayMode="auto"
              showCopyIcon
              showNavIcon
              monospace
            />
          </div>
          <div>
            <div className="text-muted-foreground text-sm font-medium mb-1">
              Recipient
            </div>
            <Address
              address={attestation.recipient}
              textClassName="text-foreground text-xs"
              displayMode="auto"
              showNavIcon
              showCopyIcon
              monospace
            />
          </div>
          {/* <div>
            <div className="text-muted-foreground text-sm font-medium mb-1">
              Schema UID
            </div>
            <CopyableText
              text={attestation.schema}
              className="text-foreground text-xs"
            />
          </div> */}
          {attestation.ref &&
            attestation.ref !==
              '0x0000000000000000000000000000000000000000000000000000000000000000' && (
              <div>
                <div className="text-muted-foreground text-sm font-medium mb-1">
                  Reference UID
                </div>
                <CopyableText
                  text={attestation.ref}
                  className="text-foreground"
                />
              </div>
            )}
          {Number(attestation.expirationTime) > 0 && (
            <div>
              <div className="text-muted-foreground text-sm font-medium mb-1">
                Expiration
              </div>
              <div className="text-foreground text-xs">
                {formatTimestamp(Number(attestation.expirationTime))}
              </div>
            </div>
          )}

          {/* Attestation Data Display */}
          <AttestationDataDisplay attestation={attestation} />
        </div>

        {/* Additional Status Messages */}
        {Number(attestation.revocationTime) > 0 && (
          <div className="border border-error bg-error-soft p-3 rounded-md">
            <div className="text-error text-sm font-medium">
              ⚠️ Revoked: {formatTimestamp(Number(attestation.revocationTime))}
            </div>
          </div>
        )}

        {Number(attestation.expirationTime) > 0 &&
          Number(attestation.expirationTime) <
            Math.floor(Date.now() / 1000) && (
            <div className="border border-warn bg-warn-soft p-3 rounded-md">
              <div className="text-warn text-sm font-medium">
                ⚠️ Expired:{' '}
                {formatTimestamp(Number(attestation.expirationTime))}
              </div>
            </div>
          )}
      </div>
    </Card>
  )
}
