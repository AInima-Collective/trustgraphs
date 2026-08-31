import { ArrowRight } from 'lucide-react'
import { isAddress, zeroAddress } from 'viem'

import { ButtonLink } from '@/components/Button'
import { Card } from '@/components/Card'
import {
  IMPORTED_FACTORY_CONFIG,
  TRUST_COMPOSE_CONFIG,
  WEIGHTED_FACTORY,
} from '@/lib/config'
import { getTargetChainConfig } from '@/lib/wagmi'

import { isFactoryAvailable } from './model'

const publicFactoryAvailable = (value: string | undefined): boolean =>
  Boolean(
    value &&
      value.toLowerCase() !== zeroAddress &&
      isAddress(value, { strict: false })
  )

const WEIGHTED_PATH_AVAILABLE = publicFactoryAvailable(WEIGHTED_FACTORY)
const COMPOSITION_PATH_AVAILABLE = publicFactoryAvailable(
  TRUST_COMPOSE_CONFIG?.factory
)
const IMPORTED_PATH_AVAILABLE =
  publicFactoryAvailable(IMPORTED_FACTORY_CONFIG?.factory) &&
  publicFactoryAvailable(IMPORTED_FACTORY_CONFIG?.governedFactory)

/** Every creation program gets a stable URL before any form state exists. */
export const CreateNetworkChooser = () => (
  <div className="space-y-8 max-w-3xl">
    <div className="space-y-2">
      <h1 className="text-2xl">Create a network</h1>
      <p className="text-sm text-muted-foreground max-w-2xl">
        Choose from the network types available on this deployment. Nothing is
        saved or sent while you choose.
      </p>
    </div>

    <div className="space-y-4">
      <Card type="accent" size="md" className="space-y-3">
        <div className="space-y-1">
          <h2 className="tg-label-strong">Standard network</h2>
          <p className="text-sm text-muted-foreground">
            Members vouch for each other and scores follow; every starting
            account you list counts equally.
          </p>
        </div>
        {isFactoryAvailable() ? (
          <ButtonLink
            href="/create/standard"
            size="sm"
            className="h-auto min-h-11 w-full justify-between whitespace-normal py-2 text-left leading-relaxed sm:h-8 sm:min-h-0 sm:w-auto sm:justify-center sm:whitespace-nowrap sm:py-0 sm:text-center sm:leading-normal"
          >
            Start a standard network
            <ArrowRight className="h-4 w-4" />
          </ButtonLink>
        ) : (
          <p className="text-sm">
            Standard networks cannot be created on {getTargetChainConfig().name}{' '}
            yet.
          </p>
        )}
      </Card>

      {IMPORTED_PATH_AVAILABLE && (
        <Card type="accent" size="md" className="space-y-3">
          <div className="space-y-1">
            <h2 className="tg-label-strong">
              Start from existing attestations
            </h2>
            <p className="text-sm text-muted-foreground">
              Preview an existing EAS schema and turn its historical
              attestations into a governed trust network.
            </p>
          </div>
          <ButtonLink href="/create/imported" variant="outline" size="sm">
            Preview an EAS schema
            <ArrowRight className="h-4 w-4" />
          </ButtonLink>
        </Card>
      )}

      {WEIGHTED_PATH_AVAILABLE && (
        <Card type="accent" size="md" className="space-y-3">
          <div className="space-y-1">
            <h2 className="tg-label-strong">Weighted starting shares</h2>
            <p className="text-sm text-muted-foreground">
              Give each starting account its own size of head start; vouches
              still decide the final scores.
            </p>
          </div>
          <ButtonLink
            href="/create/weighted"
            variant="outline"
            size="sm"
            className="h-auto min-h-11 w-full whitespace-normal py-2 text-center leading-relaxed sm:h-8 sm:min-h-0 sm:w-auto sm:whitespace-nowrap sm:py-0 sm:leading-normal"
          >
            Choose weighted shares
          </ButtonLink>
        </Card>
      )}

      {COMPOSITION_PATH_AVAILABLE && (
        <Card type="accent" size="md" className="space-y-3">
          <div className="space-y-1">
            <h2 className="tg-label-strong">Compose proved scoreboards</h2>
            <p className="text-sm text-muted-foreground">
              Blend the proven scoreboards of existing networks into one, at
              exact percentages you choose.
            </p>
          </div>
          <ButtonLink
            href="/create/composition"
            variant="outline"
            size="sm"
            className="h-auto min-h-11 w-full whitespace-normal py-2 text-center leading-relaxed sm:h-8 sm:min-h-0 sm:w-auto sm:whitespace-nowrap sm:py-0 sm:leading-normal"
          >
            Open the composition workspace
          </ButtonLink>
        </Card>
      )}
    </div>
  </div>
)
