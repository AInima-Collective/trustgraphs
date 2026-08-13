// The known-schema table, and nothing else.
//
// WHY THIS IS ITS OWN MODULE: `lib/schemas.ts` imports `SchemaEncoder` from the
// EAS SDK, which drags in ethers v6 and its provider tables. The root layout's
// client boundary reaches `registerSchemas` through `CatalogProvider`, so that
// import chain put the whole EAS + ethers stack on every route in the app,
// including a static questions page with no wallet, no attestation and no form
// on it: 1,328 KB raw in one chunk. Nothing in the registry needs an encoder.
//
// `lib/schemas.ts` re-exports `registerSchemas` from here, so existing
// call-sites are unchanged and `SchemaManager` still owns encode and decode.

import { VISIBLE_CONTRIBUTIONS_NETWORKS, VISIBLE_SEED_NETWORKS } from './config'
import { NetworkSchema } from './types'

// It used to be a `const` built from the static network list at import time, which meant a network
// created through `TrustgraphsFactory` could not be attested to until somebody rebuilt the app. It
// is a registry the runtime catalog writes into:
//   - `contexts/CatalogContext` registers every catalog network's schema on load and refresh;
//   - `contexts/NetworkContext` registers the schemas of the network it is rendering, so a page
//     served for a brand-new instance can encode a vouch on its very first paint;
//   - the static seed below keeps everything that worked before working before either runs.
const SCHEMAS = new Map<string, NetworkSchema>()

/** Add schemas to the known set. Idempotent; first registration of a uid wins. */
export const registerSchemas = (schemas: readonly NetworkSchema[]) => {
  for (const schema of schemas) {
    const key = schema.uid.toLowerCase()
    if (!SCHEMAS.has(key)) {
      SCHEMAS.set(key, schema)
    }
  }
}

/** The schema for a uid, or undefined. Keyed case-insensitively: the same uid arrives checksummed
 * from the config file and lowercased from the indexer's `/instances` route. */
export const maybeSchemaForUid = (uid: string) => SCHEMAS.get(uid.toLowerCase())

export const schemaForUid = (uid: string) => {
  const schema = maybeSchemaForUid(uid)
  if (!schema) {
    throw new Error(`Unknown schema for UID: ${uid}`)
  }
  return schema
}

// Seed: the networks shipped in `config/networks.<env>.json`. Contributions instances attest
// through the same EAS + SchemaManager flow, so their schemas (claim / response / valuation) join
// the vouching schemas here; they are not factory-minted in v1 and stay static.
registerSchemas(
  [...VISIBLE_SEED_NETWORKS, ...VISIBLE_CONTRIBUTIONS_NETWORKS].flatMap(
    (network) => network.schemas
  )
)
