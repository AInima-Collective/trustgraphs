'use client'

import { NetworkHeader } from '@/components/NetworkHeader'
import type { CompositionInstance } from '@/lib/composition/api'
import { compositionAsNetwork } from '@/lib/composition/network'
import { isSubnetworkFeatureAvailable } from '@/lib/config'
import { compositionTabs } from '@/lib/network-nav'

export const CompositionNetworkHeader = ({
  instance,
  description = false,
}: {
  instance: CompositionInstance
  description?: boolean
}) => {
  const network = compositionAsNetwork(instance)

  return (
    <NetworkHeader
      network={network}
      tabs={compositionTabs(instance, isSubnetworkFeatureAvailable())}
      description={description ? network.about : undefined}
      className="w-full"
    />
  )
}
