import type { Hex } from 'viem'

import { CompositionEpochView } from './epoch'

export default async function CompositionEpochPage({
  params,
}: {
  params: Promise<{ instanceId: Hex; checkpointId: string }>
}) {
  const { instanceId, checkpointId } = await params
  return (
    <CompositionEpochView instanceId={instanceId} checkpointId={checkpointId} />
  )
}
