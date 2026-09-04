import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { isAddress, zeroAddress } from 'viem'

import { IMPORTED_FACTORY_CONFIG } from '@/lib/config'

import { ImportedNetworkWorkspace } from './workspace'

export const metadata: Metadata = {
  title: 'Start from existing attestations',
  description:
    'Preview an existing EAS schema and create a governed Trustgraph over its history.',
}

const available = (address?: string) =>
  !!address && isAddress(address) && address.toLowerCase() !== zeroAddress

export default function CreateImportedNetworkPage() {
  if (
    !available(IMPORTED_FACTORY_CONFIG?.factory) ||
    !available(IMPORTED_FACTORY_CONFIG?.governedFactory)
  ) {
    redirect('/create')
  }
  return <ImportedNetworkWorkspace />
}
