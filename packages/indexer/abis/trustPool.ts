// Generated from `out/TrustPool.sol/TrustPool.json` (events plus the two immutables setup reads)
// and `out/IGovernor.sol/IGovernor.json` (`ProposalCreated`, the only governor event indexed:
// status and tallies are live reads in the frontend).
export const trustPoolAbi = [
  {
    type: 'function',
    name: 'governor',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract IGovernor',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'snapshot',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'address',
        internalType: 'contract MerkleSnapshot',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'Voted',
    inputs: [
      {
        name: 'proposalId',
        type: 'uint256',
        indexed: true,
        internalType: 'uint256',
      },
      {
        name: 'voter',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'support',
        type: 'uint8',
        indexed: false,
        internalType: 'uint8',
      },
      {
        name: 'score',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'weight',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'reason',
        type: 'string',
        indexed: false,
        internalType: 'string',
      },
    ],
    anonymous: false,
  },
] as const

export const governorAbi = [
  {
    type: 'event',
    name: 'ProposalCreated',
    inputs: [
      {
        name: 'proposalId',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'proposer',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'targets',
        type: 'address[]',
        indexed: false,
        internalType: 'address[]',
      },
      {
        name: 'values',
        type: 'uint256[]',
        indexed: false,
        internalType: 'uint256[]',
      },
      {
        name: 'signatures',
        type: 'string[]',
        indexed: false,
        internalType: 'string[]',
      },
      {
        name: 'calldatas',
        type: 'bytes[]',
        indexed: false,
        internalType: 'bytes[]',
      },
      {
        name: 'voteStart',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'voteEnd',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'description',
        type: 'string',
        indexed: false,
        internalType: 'string',
      },
    ],
    anonymous: false,
  },
] as const
