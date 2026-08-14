import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type ScoreBindingIdentity,
  decideParamsHashRotation,
  decideScoreBinding,
} from './score-program-binding-state.ts'

const identity: ScoreBindingIdentity = {
  instanceId: `0x${'01'.repeat(32)}`,
  programId: `0x${'02'.repeat(32)}`,
  outputDomain: `0x${'03'.repeat(32)}`,
  paramsHash: `0x${'04'.repeat(32)}`,
  conflict: false,
  conflictReason: null,
}

const incoming = {
  snapshot: `0x${'05'.repeat(20)}`,
  instanceId: identity.instanceId,
  programId: identity.programId,
  outputDomain: identity.outputDomain,
}

test('the first known identity and exact updates are accepted', () => {
  assert.deepEqual(decideScoreBinding(undefined, incoming), {
    accepted: true,
    reason: null,
  })
  assert.deepEqual(decideScoreBinding(identity, incoming), {
    accepted: true,
    reason: null,
  })
})

test('unknown programs and snapshot reinterpretation fail closed', () => {
  assert.equal(
    decideScoreBinding(undefined, { ...incoming, outputDomain: null }).accepted,
    false
  )
  assert.equal(
    decideScoreBinding(identity, {
      ...incoming,
      instanceId: `0x${'06'.repeat(32)}`,
    }).accepted,
    false
  )
  assert.equal(
    decideScoreBinding(identity, {
      ...incoming,
      outputDomain: `0x${'07'.repeat(32)}`,
    }).accepted,
    false
  )
})

test('params rotations require an unbroken authenticated hash history', () => {
  assert.deepEqual(decideParamsHashRotation(identity, identity.paramsHash), {
    accepted: true,
    reason: null,
  })
  assert.match(
    decideParamsHashRotation(identity, `0x${'08'.repeat(32)}`).reason ?? '',
    /params history mismatch/
  )
  assert.equal(
    decideParamsHashRotation(
      { ...identity, conflict: true, conflictReason: 'prior conflict' },
      identity.paramsHash
    ).accepted,
    false
  )
})
