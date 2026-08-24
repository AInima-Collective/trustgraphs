import type { Hex } from 'viem'

import { CompositionEpochView } from '../../../../compositions/[instanceId]/epochs/[checkpointId]/epoch'

export default async function NetworkProofPage({
  params,
}: {
  params: Promise<{ id: Hex; checkpointId: string }>
}) {
  const { id, checkpointId } = await params
  return <CompositionEpochView instanceId={id} checkpointId={checkpointId} />
}
