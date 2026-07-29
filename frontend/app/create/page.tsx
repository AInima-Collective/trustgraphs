import type { Metadata } from 'next'

import { CreateNetworkWizard } from './component'

export const metadata: Metadata = {
  title: 'Create a network',
  description:
    'Create a trust network for your community in one transaction: members vouch for each other, and scores follow.',
}

export default function CreateNetworkPage() {
  return <CreateNetworkWizard />
}
