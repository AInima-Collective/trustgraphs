export const trustgraphsParamsComponents = [
  { name: 'dampingFp', type: 'uint256', internalType: 'uint256' },
  { name: 'toleranceFp', type: 'uint256', internalType: 'uint256' },
  { name: 'maxIterations', type: 'uint32', internalType: 'uint32' },
  { name: 'minWeightFp', type: 'uint256', internalType: 'uint256' },
  { name: 'maxWeightFp', type: 'uint256', internalType: 'uint256' },
  { name: 'trustMultiplierFp', type: 'uint256', internalType: 'uint256' },
  { name: 'trustShareFp', type: 'uint256', internalType: 'uint256' },
  { name: 'trustDecayFp', type: 'uint256', internalType: 'uint256' },
  { name: 'trustedSeeds', type: 'address[]', internalType: 'address[]' },
  { name: 'totalPool', type: 'uint256', internalType: 'uint256' },
  { name: 'precisionScale', type: 'uint256', internalType: 'uint256' },
  { name: 'schemaUid', type: 'bytes32', internalType: 'bytes32' },
  { name: 'weightFieldIndex', type: 'uint32', internalType: 'uint32' },
  {
    name: 'envelope0DomainSeparators',
    type: 'bytes32[]',
    internalType: 'bytes32[]',
  },
  { name: 'lane2MaxHeadAge', type: 'uint64', internalType: 'uint64' },
  { name: 'accumulator', type: 'address', internalType: 'address' },
  { name: 'chainId', type: 'uint64', internalType: 'uint64' },
] as const

export const trustgraphsParamsControllerAbi = [
  {
    type: 'event',
    name: 'ParamsUpdated',
    inputs: [
      {
        name: 'instanceId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'version',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
      {
        name: 'paramsHash',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'previousParamsHash',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
      {
        name: 'params',
        type: 'tuple',
        indexed: false,
        internalType: 'struct ParamsCodec.Params',
        components: trustgraphsParamsComponents,
      },
      {
        name: 'evidenceURI',
        type: 'string',
        indexed: false,
        internalType: 'string',
      },
    ],
    anonymous: false,
  },
  {
    type: 'function',
    name: 'instanceId',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'snapshot',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'registry',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract IInstanceRegistry',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'version',
    inputs: [],
    outputs: [{ name: '', type: 'uint64', internalType: 'uint64' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'currentParamsHash',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getCurrentParams',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct ParamsCodec.Params',
        components: trustgraphsParamsComponents,
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'owner',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'pendingOwner',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
] as const

export const instanceRegistryParamsAbi = [
  {
    type: 'event',
    name: 'ParamsAuthorityUpdated',
    inputs: [
      {
        name: 'instanceId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'oldAuthority',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'newAuthority',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'function',
    name: 'getInstance',
    inputs: [{ name: 'instanceId', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct IInstanceRegistry.Instance',
        components: [
          { name: 'program', type: 'bytes32', internalType: 'bytes32' },
          { name: 'snapshot', type: 'address', internalType: 'address' },
          { name: 'verifier', type: 'address', internalType: 'address' },
          {
            name: 'registryOrAccumulator',
            type: 'address',
            internalType: 'address',
          },
          { name: 'paramsHash', type: 'bytes32', internalType: 'bytes32' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'paramsAuthority',
    inputs: [{ name: 'instanceId', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
] as const

/** Full registry event surface used for authenticated score-program discovery. */
export const instanceRegistryAbi = [
  ...instanceRegistryParamsAbi,
  {
    type: 'event',
    name: 'InstanceParamsHashUpdated',
    inputs: [
      {
        name: 'instanceId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'oldParamsHash',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
      {
        name: 'newParamsHash',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'InstanceRegistered',
    inputs: [
      {
        name: 'instanceId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'program',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'snapshot',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'verifier',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'registryOrAccumulator',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'paramsHash',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'InstanceUpdated',
    inputs: [
      {
        name: 'instanceId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'program',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'snapshot',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'verifier',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'registryOrAccumulator',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'paramsHash',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
    ],
    anonymous: false,
  },
] as const
