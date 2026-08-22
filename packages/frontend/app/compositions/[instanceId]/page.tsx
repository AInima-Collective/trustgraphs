import type { Hex } from 'viem'

import { CompositionInstanceView } from './instance'

export default async function CompositionInstancePage({
  params,
}: {
  params: Promise<{ instanceId: Hex }>
}) {
  const { instanceId } = await params
  return <CompositionInstanceView instanceId={instanceId} />
}
