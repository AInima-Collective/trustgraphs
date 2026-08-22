// Generated from `out/ProvingVault.sol/ProvingVault.json`. Kept here rather than in the
// frontend's wagmi output (like anchorRegistry and trustgraphsFactory) because the vault is not
// wired into the frontend's contract config yet. Events only: the indexer never calls it.
export const provingVaultAbi = [
  {
    type: 'event',
    name: 'AccountBound',
    inputs: [
      {
        name: 'instanceId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'snapshot',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'program',
        type: 'bytes32',
        indexed: false,
        internalType: 'bytes32',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ClaimSkipped',
    inputs: [
      {
        name: 'instanceId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'checkpointId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'reason',
        type: 'uint8',
        indexed: false,
        internalType: 'uint8',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Claimed',
    inputs: [
      {
        name: 'instanceId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'checkpointId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'recipient',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'submitter',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'feeUsd',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'gasUsd',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'ethSpent',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'usdcSpent',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'CreditAccrued',
    inputs: [
      {
        name: 'account',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'token',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'CreditWithdrawn',
    inputs: [
      {
        name: 'account',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'token',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'to',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Deposited',
    inputs: [
      {
        name: 'instanceId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'token',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'from',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'FeeScheduleUpdated',
    inputs: [
      {
        name: 'program',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'band',
        type: 'uint8',
        indexed: true,
        internalType: 'uint8',
      },
      {
        name: 'usdPerRoot',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'GasParamsUpdated',
    inputs: [
      {
        name: 'maxGasUnitsPerClaim',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'nominalGasUnits',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'PolicyUpdated',
    inputs: [
      {
        name: 'instanceId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'minPaidIntervalBlocks',
        type: 'uint64',
        indexed: false,
        internalType: 'uint64',
      },
      {
        name: 'maxPerRootUsd',
        type: 'uint96',
        indexed: false,
        internalType: 'uint96',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'PriceFeedUpdated',
    inputs: [
      {
        name: 'feed',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'maxStaleness',
        type: 'uint64',
        indexed: false,
        internalType: 'uint64',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RoleAdminChanged',
    inputs: [
      {
        name: 'role',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'previousAdminRole',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'newAdminRole',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RoleGranted',
    inputs: [
      {
        name: 'role',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'account',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'sender',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RoleRevoked',
    inputs: [
      {
        name: 'role',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'account',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'sender',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'WithdrawalCancelled',
    inputs: [
      {
        name: 'instanceId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'WithdrawalExecuted',
    inputs: [
      {
        name: 'instanceId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'to',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'ethAmount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'usdcAmount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'WithdrawalRequested',
    inputs: [
      {
        name: 'instanceId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'ethAmount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'usdcAmount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'readyAt',
        type: 'uint64',
        indexed: false,
        internalType: 'uint64',
      },
    ],
    anonymous: false,
  },
] as const
