import { contributionsParamsComponents } from './contributionsParamsController'

/**
 * `ContributionsFactory` — the contributions ROUND factory
 * (contracts/src/factory/ContributionsFactory.sol). `ContributionsInstanceCreated` is the
 * discovery event: one handler turns it into one `contributions_instance` row, and the same event
 * is what Ponder's `factory()` sources use to discover the round's resolver / snapshot /
 * distributor children (packages/indexer/ponder.config.ts) — replacing the build-time
 * `CONTRIBUTIONS_INSTANCES` import from `deployment_summary.json`.
 */
export const contributionsFactoryAbi = [
  {
    type: 'event',
    name: 'ContributionsInstanceCreated',
    inputs: [
      { name: 'instanceId', type: 'bytes32', indexed: true },
      { name: 'parentInstanceId', type: 'bytes32', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'admin', type: 'address', indexed: false },
      { name: 'name', type: 'string', indexed: false },
      { name: 'metadataURI', type: 'string', indexed: false },
      { name: 'trustAccumulator', type: 'address', indexed: false },
      { name: 'mirror', type: 'address', indexed: false },
      { name: 'resolver', type: 'address', indexed: false },
      { name: 'snapshot', type: 'address', indexed: false },
      { name: 'distributor', type: 'address', indexed: false },
      { name: 'distributorToken', type: 'address', indexed: false },
      { name: 'epochLength', type: 'uint64', indexed: false },
      { name: 'claimSchemaUid', type: 'bytes32', indexed: false },
      { name: 'responseSchemaUid', type: 'bytes32', indexed: false },
      { name: 'valuationSchemaUid', type: 'bytes32', indexed: false },
      {
        name: 'params',
        type: 'tuple',
        indexed: false,
        components: contributionsParamsComponents,
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ContributionsParamsControllerCreated',
    inputs: [
      { name: 'instanceId', type: 'bytes32', indexed: true },
      { name: 'controller', type: 'address', indexed: true },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'SchemaAdopted',
    inputs: [
      { name: 'instanceId', type: 'bytes32', indexed: true },
      { name: 'schemaIndex', type: 'uint8', indexed: false },
      { name: 'uid', type: 'bytes32', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'function',
    name: 'CLAIM_SCHEMA',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'RESPONSE_SCHEMA',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'VALUATION_SCHEMA',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
  },
] as const
