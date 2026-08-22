// Narrow event/read ABI for the factory-discovered strict EAS offchain v2 registry.
export const easOffchainAnchorRegistryAbi = [
  {
    type: 'function',
    name: 'EAS',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'contract IEAS' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'workCount',
    inputs: [],
    outputs: [{ name: '', type: 'uint64', internalType: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'NodeRegistered',
    inputs: [
      {
        name: 'nodeId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'owner',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'HeadAnchored',
    inputs: [
      {
        name: 'foldIndex',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
      {
        name: 'nodeId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'owner',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'envelopeKind',
        type: 'uint8',
        indexed: false,
        internalType: 'uint8',
      },
      {
        name: 'schemaUid',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
      {
        name: 'previousHead',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
      {
        name: 'head',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
      { name: 'count', type: 'uint64', indexed: false, internalType: 'uint64' },
      {
        name: 'dataCommitment',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
      {
        name: 'blockTimestamp',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'headSignature',
        type: 'bytes',
        indexed: false,
        internalType: 'bytes',
      },
    ],
    anonymous: false,
  },
] as const

export const easVersionAbi = [
  {
    type: 'function',
    name: 'version',
    inputs: [],
    outputs: [{ name: '', type: 'string', internalType: 'string' }],
    stateMutability: 'view',
  },
] as const
