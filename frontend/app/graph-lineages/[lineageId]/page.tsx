import type { Hex } from 'viem'

import { GraphLineageView } from './view'

export default async function GraphLineagePage({
  params,
}: {
  params: Promise<{ lineageId: Hex }>
}) {
  const { lineageId } = await params
  return <GraphLineageView lineageId={lineageId} />
}
