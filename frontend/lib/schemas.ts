// Schema UIDs for EAS attestations
// These are the standard schemas used in the application

import { SchemaEncoder } from '@ethereum-attestation-service/eas-sdk'
import { Hex, stringToHex, toHex } from 'viem'

import { VISIBLE_CONTRIBUTIONS_NETWORKS, VISIBLE_SEED_NETWORKS } from './config'
import { NetworkSchema } from './types'

// Schema definitions with metadata for UI
export type SchemaFieldType =
  | 'string'
  | 'bytes'
  | 'bytes32'
  | 'uint256'
  | 'address'

// The known-schema table. It used to be a `const` built from the static network list at import
// time, which meant a network created through `TrustGraphFactory` could not be attested to until
// somebody rebuilt the app. It is now a registry the runtime catalog writes into:
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

// Seed: the networks shipped in `config/networks.<env>.json`. Contributions instances attest
// through the same EAS + SchemaManager flow, so their schemas (claim / response / valuation) join
// the vouching schemas here; they are not factory-minted in v1 and stay static.
registerSchemas(
  [...VISIBLE_SEED_NETWORKS, ...VISIBLE_CONTRIBUTIONS_NETWORKS].flatMap(
    (network) => network.schemas
  )
)

export class SchemaManager {
  static maybeSchemaForUid(uid: string) {
    return SCHEMAS.get(uid.toLowerCase())
  }

  static schemaForUid(uid: string) {
    const schema = this.maybeSchemaForUid(uid)
    if (!schema) {
      throw new Error(`Unknown schema for UID: ${uid}`)
    }
    return schema
  }

  static encode(
    uid: string,
    // Array values cover the contribution claim schema's `address[] contributors` +
    // `uint32[] shares` fields; scalar values behave exactly as before.
    data: Record<string, string | boolean | string[] | number[]>
  ): Hex {
    const schema = this.schemaForUid(uid)

    // Ensure all data fields are present
    schema.fields.forEach((field) => {
      if (!(field.name in data)) {
        throw new Error(`Missing field: ${field.name}`)
      }
    })

    const encoder = new SchemaEncoder(
      schema.fields.map((field) => `${field.type} ${field.name}`).join(', ')
    )
    const encodedData = encoder.encodeData(
      schema.fields.map(({ name, type }) => {
        const value = data[name]
        let encodedValue =
          type.startsWith('bytes') &&
          typeof value === 'string' &&
          !value.startsWith('0x')
            ? stringToHex(value)
            : value

        // If bytes32 is not properly padded, right pad it with zeroes.
        if (
          type === 'bytes32' &&
          typeof encodedValue === 'string' &&
          encodedValue.length !== 66
        ) {
          encodedValue = encodedValue.padEnd(66, '0')
        }

        return {
          name,
          type,
          value: encodedValue,
        }
      })
    ) as Hex

    return encodedData
  }

  static decode(uid: string, data: Hex): Record<string, string | boolean> {
    const schema = this.schemaForUid(uid)

    if (!data.startsWith('0x')) {
      throw new Error(`Invalid data format: ${data}`)
    }

    const encoder = new SchemaEncoder(
      schema.fields.map((field) => `${field.type} ${field.name}`).join(', ')
    )
    const decodedData = encoder.decodeData(data)
    const parsedData = decodedData.reduce(
      (acc, { name, value: { value } }) => ({
        ...acc,
        [name]:
          typeof value === 'bigint'
            ? BigInt(value).toString()
            : value instanceof Uint8Array
              ? toHex(value)
              : typeof value !== 'string'
                ? `${value}`
                : value,
      }),
      {} as Record<string, string | boolean>
    )

    return parsedData
  }
}
