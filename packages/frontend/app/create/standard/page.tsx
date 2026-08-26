import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { CreateNetworkWizard } from '../component'
import { isFactoryAvailable } from '../model'

export const metadata: Metadata = {
  title: 'Create a standard network',
  description:
    'Create a standard trust network where members vouch for each other and starting accounts begin equally.',
}

export default function CreateStandardNetworkPage() {
  if (!isFactoryAvailable()) redirect('/create')
  return <CreateNetworkWizard />
}
