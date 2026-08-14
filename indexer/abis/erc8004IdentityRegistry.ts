/**
 * ERC-8004 Identity Registry indexed surface.
 *
 * These entries are copied verbatim from the official ABI at the pinned upstream commit below.
 * Keeping the event/function subset here (instead of a floating package import) makes Ponder's
 * decoding surface reviewable while preserving the exact official types and indexed fields.
 *
 * Upstream: https://github.com/erc-8004/erc-8004-contracts/blob/68fc6765761a10fb26f0692df21c8a6f9d12b1be/abis/IdentityRegistry.json
 * Full ABI sha256: cdb8e30f41a56ed53421126dab87551ff2a178b8463646f69f75bc5dc9620564
 */
export const erc8004IdentityRegistryAbi = [
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
        internalType: 'string',
        name: 'indexedMetadataKey',
        type: 'string',
      },
      {
        indexed: false,
        internalType: 'string',
        name: 'metadataKey',
        type: 'string',
      },
      {
        indexed: false,
        internalType: 'bytes',
        name: 'metadataValue',
        type: 'bytes',
      },
    ],
    name: 'MetadataSet',
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
        internalType: 'uint256',
        name: 'agentId',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'string',
        name: 'agentURI',
        type: 'string',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'owner',
        type: 'address',
      },
    ],
    name: 'Registered',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'from', type: 'address' },
      { indexed: true, internalType: 'address', name: 'to', type: 'address' },
      {
        indexed: true,
        internalType: 'uint256',
        name: 'tokenId',
        type: 'uint256',
      },
    ],
    name: 'Transfer',
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
        indexed: false,
        internalType: 'string',
        name: 'newURI',
        type: 'string',
      },
      {
        indexed: true,
        internalType: 'address',
        name: 'updatedBy',
        type: 'address',
      },
    ],
    name: 'URIUpdated',
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
    inputs: [{ internalType: 'uint256', name: 'agentId', type: 'uint256' }],
    name: 'getAgentWallet',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
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
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'tokenId', type: 'uint256' }],
    name: 'tokenURI',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/** Live Optimism provenance observed at block 155,542,614 on 2026-08-13. */
export const OPTIMISM_ERC8004_IDENTITY_REGISTRY = {
  chainId: 10,
  proxy: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  sourceBlock: 147_514_947,
  deploymentTransaction:
    '0x8239a11f367b65e4e6644cdc5fd9710846a0e07336274cc94b7b9f71bf2764a8',
  initialImplementation: '0xcb7af40c0be4fb92e183942b6dbb6b14a888f067',
  initialVersion: '1.0.0',
  currentImplementation: '0x7274e874ca62410a93bd8bf61c69d8045e399c02',
  currentVersion: '2.0.0',
  currentImplementationBlock: 147_514_960,
  currentImplementationTransaction:
    '0x36d10ecdf9b408620aa6cb111f26264267cde3f5898397db19bd91251184848b',
  expectedOwner: '0x547289319C3e6aedB179C0b8e8aF0B5ACd062603',
  upstreamCommit: '68fc6765761a10fb26f0692df21c8a6f9d12b1be',
  fullAbiSha256:
    'cdb8e30f41a56ed53421126dab87551ff2a178b8463646f69f75bc5dc9620564',
} as const
