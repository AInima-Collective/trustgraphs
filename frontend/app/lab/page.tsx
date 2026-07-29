import type { Metadata } from 'next'

import { LabComponent } from './component'

export const metadata: Metadata = {
  title: 'Lab',
  description: 'Live comparison surface for the mark and type axes.',
  robots: { index: false, follow: false },
}

export default function LabPage() {
  return <LabComponent />
}
