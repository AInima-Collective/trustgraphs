// Schema UIDs for EAS attestations
// These are the standard schemas used in the application

import { SchemaEncoder } from '@ethereum-attestation-service/eas-sdk'
import { Hex, stringToHex, toHex } from 'viem'

import { VISIBLE_CONTRIBUTIONS_NETWORKS, VISIBLE_NETWORKS } from './config'

// Schema definitions with metadata for UI
export type SchemaFieldType =
  | 'string'
  | 'bytes'
  | 'bytes32'
  | 'uint256'
  | 'address'

// Contributions instances attest through the same EAS + SchemaManager flow, so their schemas
// (claim / response / valuation) join the vouching schemas here.
const SCHEMAS = [
  ...VISIBLE_NETWORKS,
  ...VISIBLE_CONTRIBUTIONS_NETWORKS,
].flatMap((network) => network.schemas)

export class SchemaManager {
  static maybeSchemaForUid(uid: string) {
    return SCHEMAS.find((s) => s.uid === uid)
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
