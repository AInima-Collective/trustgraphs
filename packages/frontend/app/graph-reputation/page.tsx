import type { Metadata } from 'next'

import { GraphReputationView } from './view'

export const metadata: Metadata = {
  title: 'Graph reputation recommendations',
  description:
    'Inspect deterministic, sparse-prior, previous-epoch graph recommendations without changing composition policy.',
}

export default function GraphReputationPage() {
  return <GraphReputationView />
}
