'use client'

import { useQueries } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type Hex, isHash } from 'viem'
import { usePublicClient } from 'wagmi'

import {
  type ClaimRecovery,
  checkClaimReceipt,
  samePendingClaim,
} from '@/lib/claim-recovery'
import { getTargetChainId } from '@/lib/wagmi'

type ClaimProgress = { hash: Hex; status: 'submitted' | 'confirmed' }
type Claims = Record<string, ClaimProgress>
const claimKey = (distributor: string, id: bigint) =>
  `${distributor.toLowerCase()}:${id}`

const readClaims = (storageKey: string): Claims => {
  let claims: Claims = {}
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      claims = Object.fromEntries(
        Object.entries(raw).filter(
          ([, item]) =>
            item &&
            typeof item === 'object' &&
            isHash(item.hash) &&
            (item.status === 'submitted' || item.status === 'confirmed')
        )
      )
    }
  } catch {
    /* In-memory tracking still works without browser storage. */
  }
  return claims
}

/** Keep sent claims visible during indexer lag, including after a reload or wallet app switch. */
export function useClaimProgress(account: Hex | undefined) {
  const chainId = getTargetChainId()
  const client = usePublicClient({ chainId })
  const storageKey = `trustgraphs:claims:${chainId}:${account?.toLowerCase() ?? 'disconnected'}`
  const memory = useRef(new Map<string, Claims>())
  const activeKey = useRef(storageKey)
  activeKey.current = storageKey
  const [saved, setSaved] = useState<{ key: string; claims: Claims }>({
    key: '',
    claims: {},
  })
  useEffect(() => {
    const load = () => {
      const claims = memory.current.get(storageKey) ?? readClaims(storageKey)
      memory.current.set(storageKey, claims)
      setSaved({ key: storageKey, claims })
    }
    load()
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey) {
        memory.current.delete(storageKey)
        load()
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [storageKey])
  const update = useCallback(
    (key: string, progress: ClaimProgress | null) => {
      // Persist before React's state update: a receipt may arrive after this view unmounts.
      const claims = {
        ...(memory.current.get(storageKey) ?? readClaims(storageKey)),
      }
      if (progress) claims[key] = progress
      else delete claims[key]
      memory.current.set(storageKey, claims)
      try {
        localStorage.setItem(storageKey, JSON.stringify(claims))
      } catch {
        /* Keep the local receipt when storage is unavailable. */
      }
      if (activeKey.current === storageKey)
        setSaved({ key: storageKey, claims })
    },
    [storageKey]
  )
  const claims = saved.key === storageKey ? saved.claims : {}
  const pending = Object.entries(claims).filter(
    ([, claim]) => claim.status === 'submitted'
  )
  const receipts = useQueries({
    queries: pending.map(([, claim]) => ({
      queryKey: ['claim-receipt', chainId, claim.hash],
      queryFn: async () => {
        if (!client) return null
        // Pending transactions have no receipt yet. Retain them when the RPC is unavailable too.
        try {
          return await client.getTransactionReceipt({ hash: claim.hash })
        } catch {
          return null
        }
      },
      enabled: !!client,
      refetchInterval: 12_000,
    })),
  })
  useEffect(() => {
    pending.forEach(([key, claim], index) => {
      const receipt = receipts[index]?.data
      if (receipt)
        update(
          key,
          receipt.status === 'success'
            ? { ...claim, status: 'confirmed' }
            : null
        )
    })
  }, [pending, receipts, update])
  const recover = async (
    distributor: string,
    id: bigint,
    hash: Hex,
    clearMissing = false
  ): Promise<ClaimRecovery> => {
    const key = claimKey(distributor, id)
    const stillCurrent = () =>
      activeKey.current === storageKey &&
      samePendingClaim(memory.current.get(storageKey)?.[key], hash)
    if (!stillCurrent()) return 'changed'
    if (!client) return 'unavailable'
    // Both buttons recheck the receipt. A replacement/account change during this await
    // cannot let an old recovery action erase the new journal entry.
    const result = await checkClaimReceipt(() =>
      client.getTransactionReceipt({ hash })
    )
    if (!stillCurrent()) return 'changed'
    if (result === 'confirmed') update(key, { hash, status: 'confirmed' })
    else if (result === 'reverted') update(key, null)
    else if (result === 'missing' && clearMissing) {
      update(key, null)
      return 'cleared'
    }
    return result
  }
  return {
    ready: saved.key === storageKey,
    recover,
    get: (distributor: string, id: bigint) => claims[claimKey(distributor, id)],
    submitted: (distributor: string, id: bigint, hash: Hex) =>
      update(claimKey(distributor, id), { hash, status: 'submitted' }),
    failed: (distributor: string, id: bigint, error: unknown) => {
      if (
        error instanceof Error &&
        error.name === 'TransactionReplacementError'
      )
        update(claimKey(distributor, id), null)
    },
    confirmed: (distributor: string, id: bigint, hash: Hex) =>
      update(claimKey(distributor, id), { hash, status: 'confirmed' }),
  }
}
