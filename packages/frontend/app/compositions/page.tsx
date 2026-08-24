import type { Metadata } from 'next'

import { CompositionCatalog } from './catalog'

export const metadata: Metadata = {
  title: 'Composed networks',
  description:
    'Browse composed Trustgraphs and inspect their source policies and proof history.',
}

export default function CompositionsPage() {
  return <CompositionCatalog />
}
