import assert from 'node:assert/strict'
import test from 'node:test'

import { classifySubnetworkPower } from './subnetwork-shared'

test('classifies every named subnetwork tier from live power', () => {
  assert.deepEqual(
    classifySubnetworkPower({
      parentModule: true,
      constitutionalRole: false,
      recoveryProposer: true,
      parentModuleDelay: 0n,
    }),
    {
      verified: true,
      instruments: ['parent-module', 'recovery-proposer'],
      tier: 'admin',
    }
  )
  assert.equal(
    classifySubnetworkPower({
      parentModule: false,
      constitutionalRole: true,
      recoveryProposer: false,
      parentModuleDelay: null,
    }).tier,
    'department'
  )
  assert.equal(
    classifySubnetworkPower({
      parentModule: false,
      constitutionalRole: false,
      recoveryProposer: true,
      parentModuleDelay: null,
    }).tier,
    'guardian'
  )
  assert.deepEqual(
    classifySubnetworkPower({
      parentModule: false,
      constitutionalRole: false,
      recoveryProposer: false,
      parentModuleDelay: null,
    }),
    { verified: false, instruments: [], tier: 'label' }
  )
})

test('a delayed parent module is guardian power', () => {
  assert.equal(
    classifySubnetworkPower({
      parentModule: true,
      constitutionalRole: false,
      recoveryProposer: false,
      parentModuleDelay: 14n * 24n * 60n * 60n,
    }).tier,
    'guardian'
  )
})
