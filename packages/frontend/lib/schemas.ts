// Encoding and decoding EAS attestation data.
//
// The known-schema TABLE lives in `lib/schema-registry.ts`, which has no EAS
// import. Splitting them is not tidiness: this module pulls in `SchemaEncoder`,
// which pulls in ethers v6, and the root layout's client boundary reaches the
// registry through `CatalogProvider`. Everything that only needs to know what a
// schema looks like should import the registry; only encode and decode need
// this file.

import { SchemaEncoder } from '@ethereum-attestation-service/eas-sdk'
import { Hex, stringToHex, toHex } from 'viem'

import { maybeSchemaForUid, schemaForUid } from './schema-registry'

// Schema definitions with metadata for UI
export type SchemaFieldType =
  | 'string'
  | 'bytes'
  | 'bytes32'
  | 'uint256'
  | 'address'

export { registerSchemas } from './schema-registry'

export class SchemaManager {
  static maybeSchemaForUid(uid: string) {
    return maybeSchemaForUid(uid)
  }

  static schemaForUid(uid: string) {
    return schemaForUid(uid)
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
