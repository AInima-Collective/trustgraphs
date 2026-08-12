'use client'

import { zeroAddress } from 'viem'

import { ButtonLink } from '@/components/Button'
import { Card } from '@/components/Card'
import { CopyableText } from '@/components/CopyableText'

import { describeBlocks } from '../model'
import { Note, StepHeader, SummaryRow } from '../ui'
import { CreatedNetwork } from './ReviewStep'

export const SuccessStep = ({ created }: { created: CreatedNetwork }) => (
  <div className="space-y-6">
    <StepHeader
      title={`${created.name} is live`}
      lead="Everything your community needs exists on chain now. Here is what happens next, and what will not happen yet."
    />

    <div className="flex flex-row flex-wrap gap-2">
      <ButtonLink href={`/networks/${created.instanceId}`}>
        Go to your network
      </ButtonLink>
    </div>

    <div className="space-y-3">
      <Note tone="warning">
        Members can vouch for each other straight away. Send them your
        network&apos;s page and they can start.
      </Note>
      <Note tone="warning">
        Scores stay empty until the first set is published. Publishing means
        someone works the scores out and proves they did it correctly, which is
        scheduled to happen {describeBlocks(created.epochBlocks)}. An empty
        scoreboard on day one is normal, not a fault.
      </Note>
      <Note tone="warning">
        Your network exists on the chain from this moment. It may take a minute
        or two for the indexer to list it in this app. Keep the addresses below
        as the direct record of what was created.
      </Note>
    </div>

    <Card type="outline" size="md">
      <SummaryRow label="Your network's id">
        <CopyableText text={created.instanceId} className="text-xs" />
      </SummaryRow>
      <SummaryRow label="Where scores are published">
        <CopyableText text={created.snapshot} className="text-xs" />
      </SummaryRow>
      <SummaryRow label="Where vouches are recorded">
        <CopyableText text={created.resolver} className="text-xs" />
      </SummaryRow>
      <SummaryRow label="DAO Safe">
        <CopyableText text={created.safe} className="text-xs" />
      </SummaryRow>
      <SummaryRow label="Voting module">
        <CopyableText text={created.merkleGovModule} className="text-xs" />
      </SummaryRow>
      {created.distributor !== zeroAddress && (
        <SummaryRow label="Your shared fund">
          <CopyableText text={created.distributor} className="text-xs" />
        </SummaryRow>
      )}
    </Card>

    <Note>
      The DAO Safe owns the network contracts. Your wallet is its initial
      break-glass signer, while member proposals execute through the enabled
      voting module.
    </Note>
  </div>
)
