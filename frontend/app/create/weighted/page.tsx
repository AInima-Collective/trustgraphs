import type { Metadata } from 'next'

import { WeightedPriorWorkspace } from './workspace'

export const metadata: Metadata = {
  title: 'Create or rotate a weighted-prior network',
  description:
    'Import exact weighted priors, review concentration and commitments, create a new weighted instance, or propose a timelocked rotation.',
}

export default function WeightedPriorPage() {
  return <WeightedPriorWorkspace />
}
