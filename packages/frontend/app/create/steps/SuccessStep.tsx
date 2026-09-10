'use client'

import { useEffect, useRef, useState } from 'react'
import { zeroAddress } from 'viem'

import { Button, ButtonLink } from '@/components/Button'
import { Card } from '@/components/Card'
import { CopyableText } from '@/components/CopyableText'

import { describeBlocks } from '../model'
import { Note, StepHeader, SummaryRow } from '../ui'
import { CreatedNetwork } from './ReviewStep'

export const SuccessStep = ({ created }: { created: CreatedNetwork }) => {
  const [copyStatus, setCopyStatus] = useState('')
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const heading = contentRef.current?.querySelector<HTMLElement>(
      '[data-step-heading]'
    )
    heading?.focus({ preventScroll: true })
    heading?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }, [created.instanceId])
  return (
    <div ref={contentRef} className="space-y-6">
      <StepHeader
        title={`${created.name} is live`}
        lead="Your network was created on chain. Share its page with your community."
      />

      <div className="flex flex-row flex-wrap gap-2">
        <ButtonLink href={`/networks/${created.instanceId}`}>
          Go to your network
        </ButtonLink>
        <Button
          variant="outline"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                new URL(
                  `/networks/${created.instanceId}`,
                  window.location.origin
                ).href
              )
              setCopyStatus('Network link copied')
            } catch {
              setCopyStatus(
                'Open your network to copy its address from the browser.'
              )
            }
          }}
        >
          Copy invite link
        </Button>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {copyStatus}
      </p>

      <div className="space-y-3">
        <Note tone="warning">
          Members can vouch for each other straight away. Send them your
          network&apos;s page and they can start.
        </Note>
        <Note tone="warning">
          Scores stay empty until the first set is published. Publishing means
          someone computes and proves them. Updates become eligible{' '}
          {describeBlocks(created.epochBlocks)}; publication also depends on an
          available prover and funding. Check the score-update status on your
          network for progress.
        </Note>
        <Note tone="warning">
          Your network exists on the chain from this moment. It may take a
          minute or two for the indexer to list it in this app. Keep the
          addresses below as the direct record of what was created.
        </Note>
      </div>

      <details className="border border-border p-4">
        <summary className="cursor-pointer text-sm">
          Creation record and contract addresses
        </summary>
        <Card type="outline" size="md" className="mt-4">
          <SummaryRow label="Your network's id">
            <CopyableText text={created.instanceId} className="text-xs" />
          </SummaryRow>
          <SummaryRow label="Where scores are published">
            <CopyableText text={created.snapshot} className="text-xs" />
          </SummaryRow>
          <SummaryRow label="Where vouches are recorded">
            <CopyableText text={created.resolver} className="text-xs" />
          </SummaryRow>
          {created.offchainRegistry !== zeroAddress && (
            <SummaryRow label="Strict off-chain vouch anchors">
              <CopyableText
                text={created.offchainRegistry}
                className="text-xs"
              />
            </SummaryRow>
          )}
          <SummaryRow label="DAO Safe">
            <CopyableText text={created.safe} className="text-xs" />
          </SummaryRow>
          <SummaryRow label="Voting module">
            <CopyableText text={created.merkleGovModule} className="text-xs" />
          </SummaryRow>
          <SummaryRow label="Sealed owner-execution guard">
            <CopyableText text={created.executionGuard} className="text-xs" />
          </SummaryRow>
          <SummaryRow label="Delayed recovery module">
            <CopyableText text={created.recoveryModule} className="text-xs" />
          </SummaryRow>
          {created.signerSyncModule !== zeroAddress && (
            <SummaryRow label="Score-selected signer module">
              <CopyableText
                text={created.signerSyncModule}
                className="text-xs"
              />
            </SummaryRow>
          )}
          {created.distributor !== zeroAddress && (
            <SummaryRow label="Your shared fund">
              <CopyableText text={created.distributor} className="text-xs" />
            </SummaryRow>
          )}
        </Card>
      </details>

      <Note>
        The DAO Safe owns the network contracts and graduated atomically. Your
        wallet&apos;s owner signature cannot execute Safe transactions. Members
        act through delayed voting; your wallet may only queue a recovery action
        for a {Number(created.recoveryDelay) / 86_400}-day public delay.
      </Note>
    </div>
  )
}
