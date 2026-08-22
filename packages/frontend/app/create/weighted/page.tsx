import type { Metadata } from 'next'

import { WeightedPriorWorkspace } from './workspace'

export const metadata: Metadata = {
  title: 'Create or update a weighted network',
  description:
    'Choose starting weights, check the result, create a weighted network, or schedule an update to an existing one.',
}

export default function WeightedPriorPage() {
  return <WeightedPriorWorkspace />
}
