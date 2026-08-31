import assert from 'node:assert/strict'

import { parseGovernancePrefill } from './governance-prefill'

const bytes32 = (byte: string) => `0x${byte.repeat(64)}`
const fingerprint = bytes32('a')
const fixture = {
  version: 2,
  networkId: 'network-1',
  fingerprint,
  title: 'Update scoring',
  description: 'Reviewed rationale',
  actions: [
    {
      actionKey: 'update-network-profile',
      values: { metadataURI: 'ipfs://reviewed-profile' },
    },
    {
      actionKey: 'set-signer-sync-paused',
      values: { paused: true },
    },
  ],
  createdAt: 1_000,
}

assert.deepEqual(
  parseGovernancePrefill(
    JSON.stringify(fixture),
    fixture.networkId,
    fingerprint
  ),
  fixture
)
assert.equal(
  parseGovernancePrefill(
    JSON.stringify({
      ...fixture,
      actions: [{ actionKey: 'not-registered', values: {} }],
    }),
    fixture.networkId,
    fingerprint
  ),
  null
)
assert.equal(
  parseGovernancePrefill(
    JSON.stringify({
      ...fixture,
      version: 3,
      parentHash: bytes32('b'),
      proposedHash: bytes32('c'),
    }),
    fixture.networkId,
    fingerprint
  ),
  null
)
assert.equal(
  parseGovernancePrefill(
    JSON.stringify({
      ...fixture,
      actions: [{ actionKey: 'custom' }],
    }),
    fixture.networkId,
    fingerprint
  ),
  null
)
assert.equal(
  parseGovernancePrefill(
    JSON.stringify(fixture),
    fixture.networkId,
    bytes32('d')
  ),
  null
)

const legacyAction = {
  target: `0x${'1'.repeat(40)}`,
  value: '1000000000000000000',
  data: '0x1234',
  operation: 0,
  description: 'Legacy call',
}
assert.deepEqual(
  parseGovernancePrefill(
    JSON.stringify({
      networkId: fixture.networkId,
      fingerprint,
      parentHash: bytes32('b'),
      proposedHash: bytes32('c'),
      title: fixture.title,
      description: fixture.description,
      actions: [legacyAction],
      createdAt: fixture.createdAt,
    }),
    fixture.networkId,
    fingerprint
  ),
  {
    ...fixture,
    actions: [
      {
        actionKey: 'custom',
        values: {
          target: legacyAction.target,
          valueEth: '1',
          data: legacyAction.data,
          operation: 0,
          description: legacyAction.description,
        },
      },
    ],
  }
)

assert.equal(
  parseGovernancePrefill('{not json', fixture.networkId, fingerprint),
  null
)

console.log('governance prefill v2 and legacy migration validation: ok')
