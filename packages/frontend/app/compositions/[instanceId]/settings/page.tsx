import type { Hex } from 'viem'

import { CompositionWorkspace } from '../../../create/composition/workspace'

export default async function CompositionSettingsPage({
  params,
}: {
  params: Promise<{ instanceId: Hex }>
}) {
  const { instanceId } = await params
  return <CompositionWorkspace settingsInstanceId={instanceId} />
}
