import type { Metadata } from 'next'

import { WeightedPriorWorkspace } from './workspace'

export const metadata: Metadata = {
  title: 'Create a weighted network',
  description:
    'Choose starting weights, check the result, and create a weighted trust network.',
}

export default function WeightedPriorPage() {
  return <WeightedPriorWorkspace />
}
