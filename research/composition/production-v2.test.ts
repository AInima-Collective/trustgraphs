import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { keccak256 } from 'viem'

import {
  incompatibleThirdProgramPolicy,
  mixedFixturePolicy,
  standardSourceA,
  weightedSourceB,
} from './fixture-builder-v2'
import {
  journalEncodedV2,
  paramsEncodedV2,
  productionGoldenV2,
} from './production-v2'
import {
  SOURCE_COMPATIBILITY_CLASS_V1,
  TRUST_GRAPH_OUTPUT_DOMAIN,
  TRUST_GRAPH_PROGRAM_ID,
  WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN,
  WEIGHTED_TRUST_GRAPH_PROGRAM_ID,
  composeV2,
  sourcePolicyRootV2,
} from './reference-v2'

const checkedIn = () =>
  JSON.parse(
    readFileSync(
      new URL('../../tests/golden/trust-compose-v2.json', import.meta.url),
      'utf8'
    )
  )

test('mixed production vector is current', () => {
  const generated = productionGoldenV2()
  assert.deepEqual(generated, checkedIn())
  assert.equal(
    keccak256(paramsEncodedV2(generated.params)),
    generated.params.paramsHash
  )
  assert.equal(
    keccak256(journalEncodedV2(generated.journal)),
    generated.journal.digest
  )
})

// The decision record's independently calculated commitments, pinned literally
// so a drifting shared helper cannot silently regenerate both sides.
test('mixed vector matches the decision-record commitments byte for byte', () => {
  const generated = productionGoldenV2()
  assert.equal(
    generated.constants.sourceCompatibilityClass,
    '0x5426d501d31705b306bf65d6260a564441ff6b3b98a4375766c76348b7cca9e2'
  )
  assert.equal(
    TRUST_GRAPH_PROGRAM_ID,
    '0xdb036dae12e8641d1e58d416eec22090955469d8da1c292e2b6b02ecb9e8d380'
  )
  assert.equal(
    WEIGHTED_TRUST_GRAPH_PROGRAM_ID,
    '0xbab333b5932d7fa8073fe8ed541c0d2aef9667198b0417f43ee5c920071af2b2'
  )
  assert.equal(
    TRUST_GRAPH_OUTPUT_DOMAIN,
    '0xa8ba97693d080750d9a6972406e8f5488842c338c94b402e5f02dad3d9e9eea5'
  )
  assert.equal(
    WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN,
    '0x0509c32608494c9065912b6e03f10cfe54d31c433ffe3547fc729474342c293f'
  )
  assert.equal((generated.policyManifest.encoded.length - 2) / 2, 345)
  assert.equal((generated.capture.manifest.length - 2) / 2, 609)
  assert.equal(
    generated.policyManifest.root,
    '0x400d406845f7147a06660c33eb0806722308107e1aba2681d05bded4ed444a82'
  )
  assert.equal(
    generated.policyManifest.sha256,
    '0x0395bec4154c5bc38dc80f47ed4372c3e5cc76e3c4db4d1434105bcb247b0728'
  )
  assert.equal(
    generated.capture.manifestSha256,
    '0xe9993e1104477f854e738ad059589e6d44deac19b4a757b9ba6f7332fb82d2f6'
  )
  assert.equal(
    generated.params.paramsHash,
    '0x24f4ced83ce995541c6cbbeb9ce5c93e4c18ad4020af26b374f9965302125f22'
  )
  assert.equal(
    generated.output.root,
    '0xb69aa6c6afaac5433398e4f4d870ffce07e89584c5d224ba6a24e2916974ddd6'
  )
  assert.equal(
    generated.journal.digest,
    '0xdc5d9209f6b2beba3eb674ba89030cb11c83905bc12ce87a3b0b4d418deadd32'
  )
  assert.deepEqual(generated.sourceQuotas, [
    { sourceId: `0x${'aa'.repeat(32)}`, quota: '400' },
    { sourceId: `0x${'bb'.repeat(32)}`, quota: '600' },
  ])
  assert.deepEqual(generated.output.entries, [
    { account: `0x${'01'.repeat(20)}`, value: '360' },
    { account: `0x${'02'.repeat(20)}`, value: '140' },
    { account: `0x${'03'.repeat(20)}`, value: '200' },
    { account: `0x${'04'.repeat(20)}`, value: '300' },
  ])
})

test('source policy root is independent of source enumeration order', () => {
  const generated = productionGoldenV2()
  const sources = generated.policyManifest.entries
  assert.equal(sourcePolicyRootV2(sources), generated.policyManifest.root)
  assert.equal(
    sourcePolicyRootV2([...sources].reverse()),
    generated.policyManifest.root
  )
})

test('the unadmitted third program is rejected before its blob is touched', () => {
  // Source C carries no decodable blob at all: a rejection later than pair
  // admission would throw a different (blob) error and fail this assertion.
  assert.throws(
    () => composeV2(incompatibleThirdProgramPolicy()),
    /program is not in the compatibility class/
  )
})

test('an allowed output domain cannot admit an unknown program', () => {
  for (const domain of [
    TRUST_GRAPH_OUTPUT_DOMAIN,
    WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN,
  ]) {
    assert.throws(
      () => composeV2(incompatibleThirdProgramPolicy(undefined, domain)),
      /program is not in the compatibility class/
    )
  }
})

test("an allowed program cannot borrow the other program's output domain", () => {
  const crossed = mixedFixturePolicy()
  crossed.sources[0] = {
    ...crossed.sources[0]!,
    sourceOutputDomain: WEIGHTED_TRUST_GRAPH_OUTPUT_DOMAIN,
  }
  assert.throws(
    () => composeV2(crossed),
    /output domain does not match its program/
  )

  const crossedWeighted = mixedFixturePolicy()
  crossedWeighted.sources[1] = {
    ...crossedWeighted.sources[1]!,
    sourceOutputDomain: TRUST_GRAPH_OUTPUT_DOMAIN,
  }
  assert.throws(
    () => composeV2(crossedWeighted),
    /output domain does not match its program/
  )
})

test('a wrong compatibility class fails closed', () => {
  const wrongClass = {
    ...mixedFixturePolicy(),
    sourceCompatibilityClass: `0x${'11'.repeat(32)}` as const,
  }
  assert.throws(
    () => composeV2(wrongClass),
    /unsupported source compatibility class/
  )
})

test('a homogeneous policy from either admitted program remains valid', () => {
  const standardOnly = {
    ...mixedFixturePolicy(),
    sources: [
      standardSourceA(400_000_000_000_000_000n),
      {
        ...standardSourceA(600_000_000_000_000_000n),
        sourceId: `0x${'ab'.repeat(32)}` as const,
        snapshot: `0x${'a2'.repeat(20)}` as const,
      },
    ],
  }
  assert.equal(composeV2(standardOnly).totalValue, 1_000n)

  const weightedOnly = {
    ...mixedFixturePolicy(),
    sources: [
      weightedSourceB(400_000_000_000_000_000n),
      {
        ...weightedSourceB(600_000_000_000_000_000n),
        sourceId: `0x${'bc'.repeat(32)}` as const,
        snapshot: `0x${'b2'.repeat(20)}` as const,
      },
    ],
  }
  assert.equal(composeV2(weightedOnly).totalValue, 1_000n)
})

test('class constant derives from the normative preimage', () => {
  assert.equal(
    SOURCE_COMPATIBILITY_CLASS_V1,
    checkedIn().constants.sourceCompatibilityClass
  )
})
