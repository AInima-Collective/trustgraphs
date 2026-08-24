import { redirect } from 'next/navigation'
import type { Hex } from 'viem'

export default async function CompositionEpochPage({
  params,
}: {
  params: Promise<{ instanceId: Hex; checkpointId: string }>
}) {
  const { instanceId, checkpointId } = await params
  redirect(`/networks/${instanceId}/proofs/${checkpointId}`)
}
