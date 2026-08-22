// Schema Components Registry and Exports
// This file manages the registration of custom schema components
// and provides exports for use throughout the application

import { VISIBLE_SEED_NETWORKS } from '@/lib/config'

import { registerNetworks } from './registerNetworks'

// Seed with the shipped networks so anything that renders before the catalog resolves behaves
// exactly as it did before.
registerNetworks(VISIBLE_SEED_NETWORKS)

// Future custom schema registrations can be added here:
// schemaComponentRegistry.register('0x...', CustomReputationSchema)
// schemaComponentRegistry.register('0x...', CustomIdentitySchema)

export { registerNetworks } from './registerNetworks'
export * from './types'
export { schemaComponentRegistry } from './SchemaComponentRegistry'
export { GenericSchemaComponent } from './GenericSchemaComponent'
export { CreateVouchingSchema } from './CreateVouchingSchema'
