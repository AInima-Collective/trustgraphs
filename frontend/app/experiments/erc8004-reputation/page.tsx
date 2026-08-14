import { type Metadata } from 'next'
import Link from 'next/link'

import { Erc8004ReputationExperiment } from '@/components/Erc8004ReputationExperiment'

export const metadata: Metadata = {
  title: 'ERC-8004 reputation experiment',
  description:
    'A pinned, reproducible, unproved ERC-8004 agent reputation policy comparison.',
}

export default function Erc8004ReputationExperimentPage() {
  return (
    <div className="space-y-8">
      <nav aria-label="Breadcrumb">
        <Link
          href="/networks"
          className="text-[10px] uppercase tracking-wider text-text-subtle hover:text-text"
        >
          ← Networks
        </Link>
      </nav>
      <Erc8004ReputationExperiment />
    </div>
  )
}
