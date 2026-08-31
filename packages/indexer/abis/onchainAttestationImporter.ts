/**
 * Minimal event surface needed by Ponder. The factory/deployment slice will supply the dynamic
 * address source; keeping this ABI local avoids coupling indexer codegen to generated frontend
 * artifacts before importer instances are deployable.
 */
export const onchainAttestationImporterAbi = [
  {
    type: 'event',
    name: 'AttestationAttested',
    anonymous: false,
    inputs: [
      { name: 'eas', type: 'address', indexed: true },
      { name: 'uid', type: 'bytes32', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'AttestationRevoked',
    anonymous: false,
    inputs: [
      { name: 'eas', type: 'address', indexed: true },
      { name: 'uid', type: 'bytes32', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'ExpirationImported',
    anonymous: false,
    inputs: [
      { name: 'eas', type: 'address', indexed: true },
      { name: 'uid', type: 'bytes32', indexed: true },
      { name: 'timestamp', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AttestationImported',
    anonymous: false,
    inputs: [
      { name: 'uid', type: 'bytes32', indexed: true },
      { name: 'timestamp', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RevocationImported',
    anonymous: false,
    inputs: [
      { name: 'uid', type: 'bytes32', indexed: true },
      { name: 'timestamp', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ImportSkipped',
    anonymous: false,
    inputs: [
      { name: 'uid', type: 'bytes32', indexed: true },
      { name: 'kind', type: 'uint8', indexed: true },
      { name: 'reason', type: 'uint8', indexed: false },
    ],
  },
] as const
