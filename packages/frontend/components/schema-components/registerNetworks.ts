'use client'

import dynamic from 'next/dynamic'

import { registerSchemas } from '@/lib/schema-registry'
import { Network } from '@/lib/types'

import { schemaComponentRegistry } from './SchemaComponentRegistry'

/**
 * Teach the app about a set of trust-graph networks: their schemas become encodable
 * (`SchemaManager`) and their vouch schema gets the vouching form component.
 *
 * This used to be a module-scope loop over the static network list, which meant the vouch form
 * only existed for networks that were in the config file at build time. It is called with the
 * RUNTIME catalog (`contexts/CatalogContext`) and with whichever single network a page is
 * rendering (`contexts/NetworkContext`), so a network created a minute ago can be vouched in.
 * Idempotent: registering the same uid twice is a no-op.
 *
 * ── Why this is not in the barrel any more ──────────────────────────────────
 * `CatalogProvider` sits in the root layout, so whatever this module imports is
 * downloaded on every route in the app. Through the barrel that meant the EAS
 * SDK, ethers v6, `motion` and `react-markdown` all landed on a static
 * questions page: 864 KB gzipped of JavaScript to read fifteen paragraphs, and
 * ten seconds of main-thread work on a mid-range phone.
 *
 * Two changes fix it and neither costs a feature. The registry moved to
 * `lib/schema-registry`, which has no encoder in it. And the form is registered
 * as a lazily-loaded component rather than as itself, so the markdown renderer
 * and the animation library arrive when somebody opens a vouch form, which is
 * the only moment they can possibly be looked at.
 */
const CreateVouchingSchemaLazy = dynamic(
  () =>
    import('./CreateVouchingSchema').then((mod) => mod.CreateVouchingSchema),
  { ssr: false }
)

export const registerNetworks = (networks: readonly Network[]) => {
  for (const network of networks) {
    registerSchemas(network.schemas)
    for (const schema of network.schemas) {
      if (schema.key === 'vouching') {
        schemaComponentRegistry.register(schema.uid, CreateVouchingSchemaLazy)
      }
    }
  }
}
