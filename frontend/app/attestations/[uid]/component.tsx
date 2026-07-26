'use client'

import toast from 'react-hot-toast'

import { AttestationCard } from '@/components/AttestationCard'
import { BreadcrumbRenderer } from '@/components/BreadcrumbRenderer'
import { Button } from '@/components/Button'
import { useAttestation } from '@/hooks/useAttestation'
import { parseErrorMessage } from '@/lib/error'

interface AttestationDetailPageProps {
  uid: `0x${string}`
}

export const AttestationDetailPage = ({ uid }: AttestationDetailPageProps) => {
  const {
    revokeAttestation,
    query: { data: attestation },
    canRevoke,
    isRevoking,
  } = useAttestation(uid)

  const handleRevoke = async () => {
    if (!attestation) {
      return
    }

    try {
      await revokeAttestation(uid, attestation.schema as `0x${string}`)
    } catch (err) {
      console.error('Failed to revoke attestation:', err)
      toast.error(parseErrorMessage(err))
    }
  }

  return (
    <div className="space-y-6">
      <BreadcrumbRenderer
        fallback={{
          title: 'Attestations',
          route: '/attestations',
        }}
      />

      <div className="flex flex-row gap-x-8 gap-y-4 items-center justify-between">
        <h1 className="text-2xl">Attestation</h1>
        {canRevoke && (
          <Button
            variant="destructive"
            onClick={handleRevoke}
            size="xs"
            disabled={isRevoking}
          >
            {isRevoking ? 'Revoking...' : 'Revoke'}
          </Button>
        )}
      </div>

      {/* Attestation Card */}
      <AttestationCard uid={uid} />
    </div>
  )
}
