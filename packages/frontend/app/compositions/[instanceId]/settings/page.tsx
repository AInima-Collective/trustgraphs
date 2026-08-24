import { redirect } from 'next/navigation'
import type { Hex } from 'viem'

export default async function CompositionSettingsPage({
  params,
}: {
  params: Promise<{ instanceId: Hex }>
}) {
  const { instanceId } = await params
  redirect(`/networks/${instanceId}/settings`)
}
