import { strict as assert } from 'node:assert'

import type { Hex } from 'viem'

import { paramsHash } from './pagerank/encode'
import type { Params } from './pagerank/types'
import {
  PARAMS_SCALE,
  buildParameterActions,
  cloneParams,
  decodeParameterUpdateAction,
  formatFixed,
  paramsFingerprint,
  paramsFromChain,
  paramsFromJson,
  paramsToJson,
  parseFixed,
  serializeParams,
  validateParamsUpdate,
} from './scoring-params'

const address = (byte: string) => `0x${byte.repeat(40)}` as Hex
const bytes32 = (byte: string) => `0x${byte.repeat(64)}` as Hex

const current: Params = {
  dampingFp: 850_000_000_000_000_000n,
  toleranceFp: 1_000_000_000_000n,
  maxIterations: 100,
  minWeightFp: PARAMS_SCALE,
  maxWeightFp: 100n * PARAMS_SCALE,
  trustMultiplierFp: 3n * PARAMS_SCALE,
  trustShareFp: 500_000_000_000_000_000n,
  trustDecayFp: 800_000_000_000_000_000n,
  trustedSeeds: [address('1'), address('2')],
  totalPool: 1_000_000n * PARAMS_SCALE,
  precisionScale: PARAMS_SCALE,
  schemaUid: bytes32('a'),
  weightFieldIndex: 1,
  envelope0DomainSeparators: [],
  lane2MaxHeadAge: 0n,
  accumulator: address('3'),
  chainId: 31_337n,
}

assert.equal(parseFixed(formatFixed(current.dampingFp)), current.dampingFp)
assert.equal(parseFixed('0.000000000000000001'), 1n)
assert.throws(() => parseFixed('0.0000000000000000001'))

const json = paramsToJson(current)
assert.equal(serializeParams(paramsFromJson(json)), serializeParams(current))
assert.equal(
  paramsFingerprint(paramsFromJson(json)),
  paramsFingerprint(current)
)
assert.equal(paramsHash(paramsFromJson(json)), paramsHash(current))

const chainTuple = Object.values({
  dampingFp: current.dampingFp,
  toleranceFp: current.toleranceFp,
  maxIterations: current.maxIterations,
  minWeightFp: current.minWeightFp,
  maxWeightFp: current.maxWeightFp,
  trustMultiplierFp: current.trustMultiplierFp,
  trustShareFp: current.trustShareFp,
  trustDecayFp: current.trustDecayFp,
  trustedSeeds: current.trustedSeeds,
  totalPool: current.totalPool,
  precisionScale: current.precisionScale,
  schemaUid: current.schemaUid,
  weightFieldIndex: current.weightFieldIndex,
  envelope0DomainSeparators: [],
  lane2MaxHeadAge: 0n,
  accumulator: current.accumulator,
  chainId: current.chainId,
})
assert.equal(
  serializeParams(paramsFromChain(chainTuple)),
  serializeParams(current)
)

const changed = cloneParams(current)
changed.dampingFp = parseFixed('0.8')
changed.trustedSeeds = [address('1'), address('4')]
assert.equal(
  validateParamsUpdate(changed, current, paramsHash(current)).valid,
  true
)

const noop = validateParamsUpdate(current, current, paramsHash(current))
assert.equal(noop.valid, false)
assert.ok(noop.errors.noop)

const duplicate = cloneParams(current)
duplicate.trustedSeeds = [address('1'), address('1')]
assert.ok(validateParamsUpdate(duplicate, current).errors.trustedSeeds)

const identity = cloneParams(current)
identity.chainId = 1n
assert.ok(validateParamsUpdate(identity, current).errors.identity)

const unbounded = cloneParams(current)
unbounded.dampingFp = parseFixed('0.99')
unbounded.trustMultiplierFp = parseFixed('100')
unbounded.maxIterations = 500
assert.ok(validateParamsUpdate(unbounded, current).errors.growth)

const actions = buildParameterActions({
  controller: address('5'),
  signerCompanion: address('6'),
  proposed: changed,
  evidenceURI: 'ipfs://evidence',
})
assert.equal(actions.length, 2)
assert.equal(actions[0]?.target, address('6'))
assert.equal(actions[1]?.target, address('5'))
const decoded = decodeParameterUpdateAction(actions[1]!.data)
assert.ok(decoded)
assert.equal(decoded.evidenceURI, 'ipfs://evidence')
assert.equal(decoded.proposedHash, paramsHash(changed))
assert.equal(serializeParams(decoded.proposed), serializeParams(changed))
assert.equal(decodeParameterUpdateAction(actions[0]!.data), null)

console.log('scoring params exact round-trip and validation: ok')
