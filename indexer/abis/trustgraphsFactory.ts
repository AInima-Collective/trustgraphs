// AUTO-DERIVED from the forge artifact out/TrustgraphsFactory.sol/TrustgraphsFactory.json.
// Source of truth: src/contracts/factory/TrustgraphsFactory.sol. Kept in the indexer (not in
// frontend/lib/contract-abis.ts) so the indexer can keep a narrow event-oriented surface without
// importing frontend build output.
//
// `InstanceCreated` is the frozen discovery interface (research/INSTANCE_FACTORY.md §3): the
// indexer catalogs instances from it AND derives every child-contract address from it via Ponder
// `factory()` sources, so its shape must match the contract exactly.
export const trustgraphsFactoryAbi = [
  {
    type: 'constructor',
    inputs: [
      {
        name: 'eas',
        type: 'address',
        internalType: 'contract IEAS',
      },
      {
        name: 'schemaRegistrar',
        type: 'address',
        internalType: 'contract SchemaRegistrar',
      },
      {
        name: 'verifier',
        type: 'address',
        internalType: 'contract IZkVerifier',
      },
      {
        name: 'instanceRegistry',
        type: 'address',
        internalType: 'contract IInstanceRegistry',
      },
      {
        name: 'snapshotDeployer',
        type: 'address',
        internalType: 'contract MerkleSnapshotDeployer',
      },
      {
        name: 'distributorDeployer',
        type: 'address',
        internalType: 'contract MerkleFundDistributorDeployer',
      },
      {
        name: 'paramsControllerDeployer',
        type: 'address',
        internalType: 'contract TrustgraphsParamsControllerDeployer',
      },
      {
        name: 'epochFloor',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'vault',
        type: 'address',
        internalType: 'contract IProvingVault',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'DISTRIBUTOR_DEPLOYER',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract MerkleFundDistributorDeployer',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'EAS',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract IEAS',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'EPOCH_FLOOR',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'INSTANCE_REGISTRY',
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
    name: 'MAX_ITERATIONS',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint32',
        internalType: 'uint32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'MAX_NAME_BYTES',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'MAX_TOLERANCE_FP',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'MAX_TRUSTED_SEEDS',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'MAX_TRUST_MULTIPLIER_FP',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'PRECISION_SCALE',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'PROGRAM',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'SCHEMA_REGISTRAR',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract SchemaRegistrar',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'SNAPSHOT_DEPLOYER',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract MerkleSnapshotDeployer',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'VERIFIER',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract IZkVerifier',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'VOUCH_SCHEMA',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'string',
        internalType: 'string',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'WEIGHT_FIELD_INDEX',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'uint32',
        internalType: 'uint32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'computeInstanceId',
    inputs: [
      {
        name: 'creator',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'name',
        type: 'string',
        internalType: 'string',
      },
      {
        name: 'salt',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'createInstance',
    inputs: [
      {
        name: 'args',
        type: 'tuple',
        internalType: 'struct TrustgraphsFactory.CreateArgs',
        components: [
          {
            name: 'name',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'metadataURI',
            type: 'string',
            internalType: 'string',
          },
          {
            name: 'params',
            type: 'tuple',
            internalType: 'struct ParamsCodec.Params',
            components: [
              {
                name: 'dampingFp',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'toleranceFp',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'maxIterations',
                type: 'uint32',
                internalType: 'uint32',
              },
              {
                name: 'minWeightFp',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'maxWeightFp',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'trustMultiplierFp',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'trustShareFp',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'trustDecayFp',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'trustedSeeds',
                type: 'address[]',
                internalType: 'address[]',
              },
              {
                name: 'totalPool',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'precisionScale',
                type: 'uint256',
                internalType: 'uint256',
              },
              {
                name: 'schemaUid',
                type: 'bytes32',
                internalType: 'bytes32',
              },
              {
                name: 'weightFieldIndex',
                type: 'uint32',
                internalType: 'uint32',
              },
              {
                name: 'envelope0DomainSeparators',
                type: 'bytes32[]',
                internalType: 'bytes32[]',
              },
              {
                name: 'lane2MaxHeadAge',
                type: 'uint64',
                internalType: 'uint64',
              },
              {
                name: 'accumulator',
                type: 'address',
                internalType: 'address',
              },
              {
                name: 'chainId',
                type: 'uint64',
                internalType: 'uint64',
              },
            ],
          },
          {
            name: 'admin',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'epochLength',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'withDistributor',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'distributorToken',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'salt',
            type: 'bytes32',
            internalType: 'bytes32',
          },
        ],
      },
    ],
    outputs: [
      {
        name: 'instanceId',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'snapshot',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'resolver',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'distributor',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'schemaUid',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'validateParams',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        internalType: 'struct ParamsCodec.Params',
        components: [
          {
            name: 'dampingFp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'toleranceFp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxIterations',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'minWeightFp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxWeightFp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'trustMultiplierFp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'trustShareFp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'trustDecayFp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'trustedSeeds',
            type: 'address[]',
            internalType: 'address[]',
          },
          {
            name: 'totalPool',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'precisionScale',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'schemaUid',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'weightFieldIndex',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'envelope0DomainSeparators',
            type: 'bytes32[]',
            internalType: 'bytes32[]',
          },
          {
            name: 'lane2MaxHeadAge',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'accumulator',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'chainId',
            type: 'uint64',
            internalType: 'uint64',
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'pure',
  },
  {
    type: 'event',
    name: 'DistributorAttached',
    inputs: [
      {
        name: 'instanceId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'distributor',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'distributorToken',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'InstanceCreated',
    inputs: [
      {
        name: 'instanceId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'creator',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'admin',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'name',
        type: 'string',
        indexed: false,
        internalType: 'string',
      },
      {
        name: 'metadataURI',
        type: 'string',
        indexed: false,
        internalType: 'string',
      },
      {
        name: 'resolver',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'schemaUid',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
      {
        name: 'snapshot',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'distributor',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'distributorToken',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'epochLength',
        type: 'uint64',
        indexed: false,
        internalType: 'uint64',
      },
      {
        name: 'params',
        type: 'tuple',
        indexed: false,
        internalType: 'struct ParamsCodec.Params',
        components: [
          {
            name: 'dampingFp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'toleranceFp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxIterations',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'minWeightFp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'maxWeightFp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'trustMultiplierFp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'trustShareFp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'trustDecayFp',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'trustedSeeds',
            type: 'address[]',
            internalType: 'address[]',
          },
          {
            name: 'totalPool',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'precisionScale',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'schemaUid',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'weightFieldIndex',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'envelope0DomainSeparators',
            type: 'bytes32[]',
            internalType: 'bytes32[]',
          },
          {
            name: 'lane2MaxHeadAge',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'accumulator',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'chainId',
            type: 'uint64',
            internalType: 'uint64',
          },
        ],
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ParamsControllerCreated',
    inputs: [
      {
        name: 'instanceId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'controller',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'error',
    name: 'DerivedFieldNotZero',
    inputs: [],
  },
  {
    type: 'error',
    name: 'EmptyName',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidDamping',
    inputs: [
      {
        name: 'dampingFp',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidIterations',
    inputs: [
      {
        name: 'maxIterations',
        type: 'uint32',
        internalType: 'uint32',
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidPrecisionScale',
    inputs: [
      {
        name: 'precisionScale',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidSeed',
    inputs: [
      {
        name: 'seed',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidTolerance',
    inputs: [
      {
        name: 'toleranceFp',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidTotalPool',
    inputs: [],
  },
  {
    type: 'error',
    name: 'InvalidTrustDecay',
    inputs: [
      {
        name: 'trustDecayFp',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidTrustMultiplier',
    inputs: [
      {
        name: 'trustMultiplierFp',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidTrustShare',
    inputs: [
      {
        name: 'trustShareFp',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidWeightBounds',
    inputs: [
      {
        name: 'minWeightFp',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'maxWeightFp',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidWeightFieldIndex',
    inputs: [
      {
        name: 'weightFieldIndex',
        type: 'uint32',
        internalType: 'uint32',
      },
    ],
  },
  {
    type: 'error',
    name: 'Lane2NotSupported',
    inputs: [],
  },
  {
    type: 'error',
    name: 'NameTooLong',
    inputs: [
      {
        name: 'length',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'NoTrustedSeeds',
    inputs: [],
  },
  {
    type: 'error',
    name: 'TooManyTrustedSeeds',
    inputs: [
      {
        name: 'count',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  {
    type: 'error',
    name: 'ZeroAddress',
    inputs: [],
  },
] as const
