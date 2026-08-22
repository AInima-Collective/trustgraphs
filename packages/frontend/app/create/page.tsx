import type { Metadata } from 'next'

import { CreateNetworkWizard } from './component'

export const metadata: Metadata = {
  title: 'Create a network',
  description:
    'Create a trust network for your community: a standard network where members vouch for each other, weighted starting shares, or a blend of proven scoreboards.',
}

export default function CreateNetworkPage() {
  return <CreateNetworkWizard />
}
