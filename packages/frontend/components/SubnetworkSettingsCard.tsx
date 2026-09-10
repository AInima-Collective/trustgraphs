import { GitFork } from 'lucide-react'

import { ButtonLink } from '@/components/Button'
import { Card } from '@/components/Card'

export const SubnetworkSettingsCard = ({
  networkId,
  instanceId,
}: {
  networkId: string
  instanceId: string
}) => (
  <Card type="primary" size="md" className="min-w-0">
    <h3 className="text-base font-medium">Sub-networks</h3>
    <p className="mt-1 text-xs leading-5 text-muted-foreground">
      Create child networks and manage requests to join this network.
    </p>
    <div className="mt-4 flex flex-wrap gap-2">
      <ButtonLink
        href={`/create/standard?parent=${instanceId}&parentRoute=${encodeURIComponent(networkId)}`}
        size="sm"
      >
        <GitFork className="h-4 w-4" /> Create a sub-network
      </ButtonLink>
      <ButtonLink
        href={`/networks/${networkId}/subnetworks`}
        variant="outline"
        size="sm"
      >
        Manage relationships
      </ButtonLink>
    </div>
  </Card>
)
