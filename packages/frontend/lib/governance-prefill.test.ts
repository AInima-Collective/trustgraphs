import assert from 'node:assert/strict'

import { parseGovernancePrefill } from './governance-prefill'

const bytes32 = (byte: string) => `0x${byte.repeat(64)}`
const fingerprint = bytes32('a')
const fixture = {
  networkId: 'network-1',
  fingerprint,
  parentHash: bytes32('b'),
  proposedHash: bytes32('c'),
  title: 'Update scoring',
  description: 'Reviewed rationale',
  actions: [
    {
      target: `0x${'1'.repeat(40)}`,
      value: '0',
      data: '0x1234',
      operation: 0,
      description: 'Publish settings',
      contractName: 'TrustgraphsParamsController',
      functionSignature: 'updateParams(Params,string)',
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
      actions: [{ ...fixture.actions[0], operation: 2 }],
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
      actions: [{ ...fixture.actions[0], value: 'garbage' }],
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
assert.equal(
  parseGovernancePrefill('{not json', fixture.networkId, fingerprint),
  null
)

console.log('governance prefill JSON boundary validation: ok')
