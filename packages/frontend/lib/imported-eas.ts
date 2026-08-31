import { SchemaEncoder } from '@ethereum-attestation-service/eas-sdk'
import { type Abi, type Hex, parseAbi } from 'viem'

import { governedTrustgraphsFactoryAbi } from './contract-abis'

const ordinaryCreate = governedTrustgraphsFactoryAbi.find(
  (item) => item.type === 'function' && item.name === 'createGovernedInstance'
)
if (!ordinaryCreate || ordinaryCreate.type !== 'function') {
  throw new Error('Governed factory ABI is missing createGovernedInstance')
}

/** The imported wrapper differs only by the immutable source schema argument. */
export const governedImportedFactoryAbi: Abi = [
  ...governedTrustgraphsFactoryAbi.filter(
    (item) => item.type !== 'function' || item.name !== 'createGovernedInstance'
  ),
  {
    ...ordinaryCreate,
    name: 'createGovernedImportedInstance',
    inputs: [
      ordinaryCreate.inputs[0]!,
      { name: 'importedSchemaUid', type: 'bytes32' },
      ...ordinaryCreate.inputs.slice(1),
    ],
  },
]

export const easAttestAndImportRouterAbi = parseAbi([
  'function attestAndImport((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data,(uint8 v,bytes32 r,bytes32 s) signature,address attester,uint64 deadline) request) payable returns (bytes32 uid)',
  'function multiAttestAndImport((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value)[] data,(uint8 v,bytes32 r,bytes32 s)[] signatures,address attester,uint64 deadline)[] requests) payable returns (bytes32[] uids)',
])

export const onchainAttestationImporterAbi = parseAbi([
  'function attestationsProcessed(bytes32 uid) view returns (bool)',
  'function revocationsProcessed(bytes32 uid) view returns (bool)',
  'function expirationsProcessed(bytes32 uid) view returns (bool)',
  'function importAttestations(bytes32[] uids) returns (uint256 folded,uint256 skipped)',
  'function importRevocations(bytes32[] uids) returns (uint256 folded,uint256 skipped)',
  'function importExpirations(bytes32[] uids) returns (uint256 folded,uint256 skipped)',
])

export type EasSchemaPreview = {
  schema: {
    uid: Hex
    schema: string
    resolver: Hex
    revocable: boolean
    registerer: Hex
    fields: Array<{
      index: number
      type: string
      name: string
      numeric: boolean
    }>
    numericWeightCandidates: Array<{
      index: number
      type: string
      name: string
      numeric: true
    }>
  }
  counts: {
    attestations: number
    uniqueAttesters: number
    uniqueRecipients: number
  }
  samples: Array<{
    uid: Hex
    attester: Hex
    recipient: Hex
    data: Hex
    time: string
    expirationTime: string
    revocationTime: string
    blockNumber: string
  }>
  graphPreview: { nodes: number; edges: number; sampled: boolean }
}

export const decodeLegacySample = (schema: string, data: Hex) => {
  try {
    return Object.fromEntries(
      new SchemaEncoder(schema)
        .decodeData(data)
        .map(({ name, value }) => [
          name,
          typeof value.value === 'bigint'
            ? value.value.toString()
            : String(value.value),
        ])
    )
  } catch {
    return null
  }
}
