import type { Hex } from 'viem'

import { CompositionPolicyView } from '../../../../compositions/[instanceId]/policies/[version]/policy'

export default async function NetworkPolicyPage({
  params,
}: {
  params: Promise<{ id: Hex; version: string }>
}) {
  const { id, version } = await params
  return <CompositionPolicyView instanceId={id} version={version} />
}
