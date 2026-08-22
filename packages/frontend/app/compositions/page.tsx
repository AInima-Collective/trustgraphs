import type { Metadata } from 'next'

import { CompositionCatalog } from './catalog'

export const metadata: Metadata = {
  title: 'Composition provenance',
  description:
    'Inspect trust-compose policy, capture, output, proof, and governance receipts.',
}

export default function CompositionsPage() {
  return <CompositionCatalog />
}
