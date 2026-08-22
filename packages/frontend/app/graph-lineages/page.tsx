import type { Metadata } from 'next'

import { GraphLineageCatalog } from './catalog'

export const metadata: Metadata = {
  title: 'Graph lineage provenance',
  description:
    'Inspect authenticated graph identities, configuration and epoch history, and typed scoped endorsements.',
}

export default function GraphLineagesPage() {
  return <GraphLineageCatalog />
}
