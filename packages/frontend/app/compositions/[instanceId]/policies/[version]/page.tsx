import { redirect } from 'next/navigation'
import type { Hex } from 'viem'

export default async function CompositionPolicyPage({
  params,
}: {
  params: Promise<{ instanceId: Hex; version: string }>
}) {
  const { instanceId, version } = await params
  redirect(`/networks/${instanceId}/policies/${version}`)
}
