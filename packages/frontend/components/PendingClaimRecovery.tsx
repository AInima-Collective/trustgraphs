'use client'

import { useState } from 'react'
import type { Hex } from 'viem'

import { Button } from '@/components/Button'
import type { useClaimProgress } from '@/hooks/useClaimProgress'
import type { ClaimRecovery } from '@/lib/claim-recovery'

export const PendingClaimRecovery = ({
  progress,
  distributor,
  id,
  hash,
  onRefresh,
  disabled = false,
}: {
  progress: ReturnType<typeof useClaimProgress>
  distributor: string
  id: bigint
  hash: Hex
  onRefresh: () => void
  disabled?: boolean
}) => {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ClaimRecovery | null>(null)
  const recover = async (clear = false) => {
    setBusy(true)
    try {
      const next = await progress.recover(distributor, id, hash, clear)
      setResult(next)
      if (next === 'confirmed' || next === 'reverted' || next === 'cleared')
        onRefresh()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="min-w-0 space-y-2 whitespace-normal text-sm sm:max-w-xs">
      <Button
        size="sm"
        variant="outline"
        onClick={() => void recover()}
        disabled={busy || disabled}
      >
        {busy ? 'Checking transaction…' : 'Check pending claim'}
      </Button>
      {result === 'missing' && (
        <>
          <p
            className="text-xs leading-relaxed text-muted-foreground"
            role="status"
          >
            No receipt was found. Check your wallet: this claim may still be
            pending, cancelled, or replaced. If your wallet shows it was
            cancelled or replaced, clear local tracking to check the reward
            again. This does not cancel a transaction or mark the reward
            claimed.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void recover(true)}
            disabled={busy || disabled}
          >
            Clear local tracking
          </Button>
        </>
      )}
      {result === 'unavailable' && (
        <p role="status" className="text-xs text-muted-foreground">
          The transaction could not be checked. Your tracking is saved; retry
          when the connection recovers.
        </p>
      )}
      {result === 'changed' && (
        <p role="status" className="text-xs text-muted-foreground">
          The wallet or transaction changed. Check its current status again.
        </p>
      )}
    </div>
  )
}
