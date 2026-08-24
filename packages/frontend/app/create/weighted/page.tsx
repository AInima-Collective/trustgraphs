import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { WeightedPriorWorkspace } from './workspace'

export const metadata: Metadata = {
  title: 'Create a weighted network',
  description:
    'Choose starting weights, check the result, and create a weighted trust network.',
}

export default async function WeightedPriorPage({
  searchParams,
}: {
  searchParams: Promise<{ instance?: string | string[] }>
}) {
  const { instance } = await searchParams
  const legacyInstance = Array.isArray(instance) ? instance[0] : instance
  if (legacyInstance && /^0x[0-9a-fA-F]{64}$/.test(legacyInstance)) {
    redirect(`/networks/${legacyInstance}/settings?tab=scoring`)
  }
  return <WeightedPriorWorkspace />
}
