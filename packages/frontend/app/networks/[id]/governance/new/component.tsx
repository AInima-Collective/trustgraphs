'use client'

import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { isHex, zeroHash } from 'viem'

import {
  CreateProposalForm,
  type ProposalDraftContent,
} from '@/components/CreateProposalForm'
import { useNetwork } from '@/contexts/NetworkContext'
import { useGovernance } from '@/hooks/useGovernance'
import {
  clearGovernancePrefill,
  loadGovernancePrefill,
  parseGovernancePrefill,
} from '@/lib/governance-prefill'

function NewProposalPageContent() {
  const { network } = useNetwork()
  const router = useRouter()
  const searchParams = useSearchParams()
  const fingerprint =
    searchParams.get('actionDraft') ?? searchParams.get('scoringDraft')
  const storageFingerprint =
    fingerprint?.length === 66 && isHex(fingerprint, { strict: true })
      ? fingerprint
      : zeroHash
  const [loadedDraft, setLoadedDraft] = useState<{
    key: string
    prefill: ReturnType<typeof loadGovernancePrefill>
  } | null>(null)
  const draftKey = `${network.id}:${fingerprint ?? 'new'}`
  const storageKey = `trustgraph:proposal-draft:${draftKey}`
  const submitted = useRef(false)
  const [draftStatus, setDraftStatus] = useState('')
  const {
    canCreateProposal,
    userVotingPower,
    createProposal,
    isAnyActionLoading,
    isLoadingModule,
    isLoadingUserVotingPower,
  } = useGovernance()

  useEffect(() => {
    submitted.current = false
    let saved = null
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (raw)
        saved = parseGovernancePrefill(raw, network.id, storageFingerprint)
    } catch {
      /* The builder remains usable when storage is unavailable. */
    }
    setLoadedDraft({
      key: draftKey,
      prefill: saved ?? loadGovernancePrefill(network.id, fingerprint),
    })
  }, [draftKey, fingerprint, network.id, storageFingerprint, storageKey])

  const saveDraft = useCallback(
    (draft: ProposalDraftContent) => {
      if (submitted.current) return
      try {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify({
            ...draft,
            version: 2,
            networkId: network.id,
            fingerprint: storageFingerprint,
            createdAt: Date.now(),
          })
        )
        setDraftStatus('Draft saved in this browser')
      } catch {
        setDraftStatus('Draft could not be saved in this browser')
      }
    },
    [network.id, storageFingerprint, storageKey]
  )

  return (
    <div className="space-y-8">
      <header className="space-y-4">
        <Link
          href={`/networks/${network.id}/governance`}
          className="inline-flex items-center gap-2 text-xs text-text-muted hover:text-text"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          All proposals
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-2">
            <h2 className="text-3xl">Create a proposal</h2>
            <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
              Give your network a clear decision. Explain the why, build the
              actions, and review what happens next.
            </p>
          </div>
          <span className="border border-border px-3 py-1.5 text-xs text-text-muted">
            Draft proposal
          </span>
        </div>
      </header>
      {loadedDraft?.key === draftKey ? (
        <>
          {fingerprint && !loadedDraft.prefill && (
            <p
              role="status"
              className="border border-warn/40 bg-warn-soft p-4 text-sm"
            >
              This action draft is unavailable in this browser. Open it again
              from the original workflow, or start a new proposal below.
            </p>
          )}
          <CreateProposalForm
            key={draftKey}
            canCreateProposal={canCreateProposal}
            userVotingPower={userVotingPower?.value}
            isLoading={
              isAnyActionLoading || isLoadingModule || isLoadingUserVotingPower
            }
            prefill={loadedDraft.prefill}
            onDraftChange={saveDraft}
            draftStatus={draftStatus}
            onCreateProposal={async (title, description, actions, voteType) => {
              const hash = await createProposal(
                title,
                description,
                actions,
                voteType
              )
              if (hash) {
                submitted.current = true
                try {
                  window.localStorage.removeItem(storageKey)
                  if (fingerprint)
                    clearGovernancePrefill(network.id, fingerprint)
                } catch {
                  /* A confirmed transaction must still navigate if storage fails. */
                }
                router.push(`/networks/${network.id}/governance`)
              }
              return hash
            }}
          />
        </>
      ) : (
        <p role="status" className="py-12 text-sm text-text-muted">
          Loading proposal builder…
        </p>
      )}
    </div>
  )
}

export default function NewProposalPage() {
  return (
    <Suspense fallback={<p role="status">Loading proposal builder…</p>}>
      <NewProposalPageContent />
    </Suspense>
  )
}
