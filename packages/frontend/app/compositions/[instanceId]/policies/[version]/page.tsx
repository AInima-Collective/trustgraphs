import type { Hex } from 'viem'

import { CompositionPolicyView } from './policy'

export default async function CompositionPolicyPage({
  params,
}: {
  params: Promise<{ instanceId: Hex; version: string }>
}) {
  const { instanceId, version } = await params
  return <CompositionPolicyView instanceId={instanceId} version={version} />
}
