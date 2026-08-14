import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { type Hex } from 'viem'

import { fixturePolicy, postTriggerPolicy } from './fixture-builder'
import {
  compose,
  decodeCanonicalScoreBlob,
  hamilton,
  outputRoot,
  sha256Hex,
} from './reference'

const golden = JSON.parse(
  readFileSync(new URL('./golden.json', import.meta.url), 'utf8')
) as {
  sourceStates: Array<{
    sourceId: Hex
    blobSha256: Hex
    cid: string
    outputRoot: Hex
    totalValue: string
  }>
  manifestSha256: Hex
  sourceQuotas: Record<string, string>
  sourceAllocations: Record<string, Record<string, string>>
  output: Record<string, string>
  outputBlobSha256: Hex
  outputCid: string
  outputRoot: Hex
  totalValue: string
  postTriggerUpdate: { outputRoot: Hex; manifestSha256: Hex }
  expectedFailures: Record<string, string>
}

const record = <T extends { account: Hex; value: bigint }>(entries: T[]) =>
  Object.fromEntries(
    entries.map((entry) => [entry.account, entry.value.toString()])
  )

test('three-source golden pins unequal pools, overlap, missing accounts, and rounding', () => {
  const policy = fixturePolicy()
  const result = compose(policy)

  assert.deepEqual(
    policy.sources.map((source) => ({
      sourceId: source.sourceId,
      blobSha256: source.blobSha256,
      cid: source.cid,
      outputRoot: source.outputRoot,
      totalValue: source.totalValue.toString(),
    })),
    golden.sourceStates
  )
  assert.equal(result.manifestSha256, golden.manifestSha256)
  assert.deepEqual(
    Object.fromEntries(
      result.sourceAllocations.map((source) => [
        source.sourceId,
        source.quota.toString(),
      ])
    ),
    golden.sourceQuotas
  )
  assert.deepEqual(
    Object.fromEntries(
      result.sourceAllocations.map((source) => [
        source.sourceId,
        record(source.allocations),
      ])
    ),
    golden.sourceAllocations
  )
  assert.deepEqual(record(result.output), golden.output)
  assert.equal(result.outputBlobSha256, golden.outputBlobSha256)
  assert.equal(result.outputCid, golden.outputCid)
  assert.equal(result.outputRoot, golden.outputRoot)
  assert.equal(result.totalValue.toString(), golden.totalValue)

  // The 1e24, 100, and 7 point source pools receive only their declared source weights.
  assert.deepEqual(
    result.sourceAllocations.map((source) => source.quota),
    [333_000n, 333_000n, 334_000n]
  )
})

test('source enumeration order cannot change the manifest or output', () => {
  const policy = fixturePolicy()
  const forward = compose(policy)
  const reversed = compose({
    ...policy,
    sources: [...policy.sources].reverse(),
  })
  assert.deepEqual(reversed, forward)
})

test('source A exactly reproduces the existing trust-graph golden commitments', () => {
  const source = fixturePolicy().sources[0]!
  assert.equal(
    source.blob,
    JSON.parse(
      readFileSync(
        new URL('../../test/golden/trust-graph.json', import.meta.url),
        'utf8'
      )
    ).cid.blob
  )
  assert.equal(sha256Hex(source.blob), source.blobSha256)
  assert.equal(
    outputRoot(decodeCanonicalScoreBlob(source.blob)),
    source.outputRoot
  )
})

test('wrong bytes, wrong root, and stale source references fail closed', () => {
  const wrongBlob = fixturePolicy()
  wrongBlob.sources[0] = {
    ...wrongBlob.sources[0]!,
    blob: wrongBlob.sources[0]!.blob.replace('220016', '220017'),
  }
  assert.throws(
    () => compose(wrongBlob),
    new RegExp(golden.expectedFailures.wrongBlob)
  )

  const wrongRoot = fixturePolicy()
  wrongRoot.sources[0] = {
    ...wrongRoot.sources[0]!,
    outputRoot: `0x${'00'.repeat(32)}` as Hex,
  }
  assert.throws(
    () => compose(wrongRoot),
    new RegExp(golden.expectedFailures.wrongRoot)
  )

  const wrongCid = fixturePolicy()
  wrongCid.sources[0] = {
    ...wrongCid.sources[0]!,
    cid: wrongCid.sources[1]!.cid,
  }
  assert.throws(() => compose(wrongCid), /CID mismatch/)

  const stale = fixturePolicy()
  stale.sources[0] = {
    ...stale.sources[0]!,
    maxAgeBlocks: 99n,
  }
  assert.throws(() => compose(stale), new RegExp(golden.expectedFailures.stale))
})

test('a source update after trigger cannot alter the frozen checkpoint', () => {
  const frozen = compose(fixturePolicy())
  const nextEpoch = compose(postTriggerPolicy())
  assert.equal(frozen.outputRoot, golden.outputRoot)
  assert.equal(nextEpoch.outputRoot, golden.postTriggerUpdate.outputRoot)
  assert.equal(
    nextEpoch.manifestSha256,
    golden.postTriggerUpdate.manifestSha256
  )
  assert.notEqual(nextEpoch.outputRoot, frozen.outputRoot)
  assert.notEqual(nextEpoch.manifestSha256, frozen.manifestSha256)
})

test('Hamilton tie order and conservation are canonical at sub-point boundaries', () => {
  const result = hamilton(2n, 3n, [
    { key: 'c', value: 1n, data: 'c' },
    { key: 'a', value: 1n, data: 'a' },
    { key: 'b', value: 1n, data: 'b' },
  ])
  assert.deepEqual(
    result.map(({ key, allocation }) => [key, allocation]),
    [
      ['a', 1n],
      ['b', 1n],
      ['c', 0n],
    ]
  )
  assert.equal(
    result.reduce((sum, item) => sum + item.allocation, 0n),
    2n
  )
})

test('a source allocated its own total reproduces every published value exactly', () => {
  const source = fixturePolicy().sources[0]!
  const entries = decodeCanonicalScoreBlob(source.blob)
  const reproduced = hamilton(
    source.totalValue,
    source.totalValue,
    entries.map((entry) => ({
      key: entry.account,
      value: entry.value,
      data: entry.account,
    }))
  )
  assert.deepEqual(
    reproduced.map(({ data: account, allocation: value }) => ({
      account,
      value,
    })),
    entries
  )
})

test('required sources with sub-point quotas are rejected instead of disappearing', () => {
  const policy = fixturePolicy()
  policy.outputPool = 2n
  assert.throws(() => compose(policy), /at least one output point/)
})

test('noncanonical blobs and aggregate bound violations are rejected', () => {
  assert.throws(
    () =>
      decodeCanonicalScoreBlob(
        '{"0x0101010101010101010101010101010101010101":"01"}'
      ),
    /canonical positive decimal/
  )
  const bounded = fixturePolicy()
  bounded.bounds = {
    ...bounded.bounds,
    maxEntriesPerSource: 5,
    maxAggregateEntries: 5,
    maxUnionAccounts: 5,
  }
  assert.throws(() => compose(bounded), /aggregate source entries/)

  const raised = fixturePolicy()
  raised.bounds = { ...raised.bounds, maxSources: 9 }
  assert.throws(() => compose(raised), /exceeds the V1 ceiling/)
})
