import type { Metadata } from 'next'

import { CompositionWorkspace } from './workspace'

export const metadata: Metadata = {
  title: 'Compose proved TrustGraph distributions',
  description:
    'Preview exact governed distribution blends, deploy authenticated source adapters, and create or rotate trust-compose policies.',
}

export default function CompositionPage() {
  return <CompositionWorkspace />
}
