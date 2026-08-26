/**
 * ERC-8004 Reputation Registry indexed surface.
 *
 * Entries are copied from the official ABI at the pinned upstream commit. Keeping the exact event
 * types and indexed fields local prevents an upstream draft change from silently changing log
 * decoding.
 *
 * Upstream: https://github.com/erc-8004/erc-8004-contracts/blob/68fc6765761a10fb26f0692df21c8a6f9d12b1be/abis/ReputationRegistry.json
 * Full ABI sha256: 867b7975a5f2f9fee38c4a148a84471b141f4de91409ccc0c6bebe3df4f04001
 */
export const erc8004ReputationRegistryAbi = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'uint256',
        name: 'agentId',
        type: 'uint256',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'clientAddress',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint64',
        name: 'feedbackIndex',
        type: 'uint64',
      },
      {
        indexed: false,
        internalType: 'int128',
        name: 'value',
        type: 'int128',
      },
      {
        indexed: false,
        internalType: 'uint8',
        name: 'valueDecimals',
        type: 'uint8',
      },
      {
        indexed: true,
        internalType: 'string',
        name: 'indexedTag1',
        type: 'string',
      },
      {
        indexed: false,
        internalType: 'string',
        name: 'tag1',
        type: 'string',
      },
      {
        indexed: false,
        internalType: 'string',
        name: 'tag2',
        type: 'string',
      },
      {
        indexed: false,
        internalType: 'string',
        name: 'endpoint',
        type: 'string',
      },
      {
        indexed: false,
        internalType: 'string',
        name: 'feedbackURI',
        type: 'string',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'feedbackHash',
        type: 'bytes32',
      },
    ],
    name: 'NewFeedback',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'uint256',
        name: 'agentId',
        type: 'uint256',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'clientAddress',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'uint64',
        name: 'feedbackIndex',
        type: 'uint64',
      },
    ],
    name: 'FeedbackRevoked',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'uint256',
        name: 'agentId',
        type: 'uint256',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'clientAddress',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'uint64',
        name: 'feedbackIndex',
        type: 'uint64',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'responder',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'string',
        name: 'responseURI',
        type: 'string',
      },
      {
        indexed: false,
        internalType: 'bytes32',
        name: 'responseHash',
        type: 'bytes32',
      },
    ],
    name: 'ResponseAppended',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'previousOwner',
        type: 'address',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'newOwner',
        type: 'address',
      },
    ],
    name: 'OwnershipTransferred',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'implementation',
        type: 'address',
      },
    ],
    name: 'Upgraded',
    type: 'event',
  },
  {
    inputs: [],
    name: 'getIdentityRegistry',
    outputs: [
      { internalType: 'address', name: 'identityRegistry', type: 'address' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getVersion',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'pure',
    type: 'function',
  },
  {
    inputs: [],
    name: 'owner',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const
