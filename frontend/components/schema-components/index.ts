// Schema Components Registry and Exports
// This file manages the registration of custom schema components
// and provides exports for use throughout the application

import { VISIBLE_SEED_NETWORKS } from '@/lib/config'
import { registerSchemas } from '@/lib/schemas'
import { Network } from '@/lib/types'

// Import components and registry for registration
import { CreateVouchingSchema } from './CreateVouchingSchema'
import { schemaComponentRegistry } from './SchemaComponentRegistry'

/**
 * Teach the app about a set of trust-graph networks: their schemas become encodable
 * (`SchemaManager`) and their vouch schema gets the vouching form component.
 *
 * This used to be a module-scope loop over the static network list, which meant the vouch form
 * only existed for networks that were in the config file at build time. It is now called with the
 * RUNTIME catalog (`contexts/CatalogContext`) and with whichever single network a page is
 * rendering (`contexts/NetworkContext`), so a network created a minute ago can be vouched in.
 * Idempotent — registering the same uid twice is a no-op.
 */
export const registerNetworks = (networks: readonly Network[]) => {
  for (const network of networks) {
    registerSchemas(network.schemas)
    for (const schema of network.schemas) {
      if (schema.key === 'vouching') {
        schemaComponentRegistry.register(schema.uid, CreateVouchingSchema)
      }
    }
  }
}

// Seed with the shipped networks so anything that renders before the catalog resolves behaves
// exactly as it did before.
registerNetworks(VISIBLE_SEED_NETWORKS)

// Future custom schema registrations can be added here:
// schemaComponentRegistry.register('0x...', CustomReputationSchema)
// schemaComponentRegistry.register('0x...', CustomIdentitySchema)

export * from './types'
export { schemaComponentRegistry } from './SchemaComponentRegistry'
export { GenericSchemaComponent } from './GenericSchemaComponent'
export { CreateVouchingSchema } from './CreateVouchingSchema'
