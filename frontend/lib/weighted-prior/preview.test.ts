import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

import { type Address, type Hex } from 'viem'

import {
  equalWeightCsv,
  parseWeightedSource,
  resolveWeightedSource,
} from './import'
import {
  WEIGHTED_PREVIEW_ALWAYS_ASYNC,
  runWeightedPreview,
  weightedRotationDiff,
} from './preview'

const anchor = {
  chainId: 1,
  blockNumber: 100n,
  blockHash: `0x${'11'.repeat(32)}` as Hex,
}
const neverResolve = async () => null
const account = (index: number) =>
  `0x${index.toString(16).padStart(40, '0')}` as Address

const main = async () => {
  const small = await resolveWeightedSource(
    parseWeightedSource(
      equalWeightCsv([account(1), account(2), account(3)]),
      'csv',
      10n
    ),
    anchor,
    neverResolve
  )
  const dayZero = runWeightedPreview(small)
  assert.deepEqual(
    dayZero.scores.map(([address, weight]) => [address, weight.toString()]),
    small.normalizedEntries.map((entry) => [
      entry.account,
      entry.weight.toString(),
    ]),
    'prior-only accounts receive exact day-zero leaves before any vouch exists'
  )
  assert.equal(dayZero.iterations, 40)

  const changed = await resolveWeightedSource(
    parseWeightedSource(
      `account,weight\n${account(1)},3\n${account(3)},1\n${account(4)},2\n`,
      'csv',
      10n
    ),
    anchor,
    neverResolve
  )
  const diff = weightedRotationDiff(
    small.normalizedEntries.map((entry) => ({
      account: entry.account,
      normalizedWeight: entry.weight,
    })),
    changed
  )
  assert.deepEqual(
    diff.added.map((entry) => entry.account),
    [account(4)]
  )
  assert.deepEqual(
    diff.removed.map((entry) => entry.account),
    [account(2)]
  )
  assert.equal(diff.changed.length, 2)

  const maxAccounts = Array.from({ length: 2048 }, (_, index) =>
    account(index + 1)
  )
  const started = performance.now()
  const max = await resolveWeightedSource(
    parseWeightedSource(equalWeightCsv(maxAccounts), 'csv', 10n),
    anchor,
    neverResolve
  )
  const maximumPreview = runWeightedPreview(max)
  const elapsedMs = performance.now() - started
  assert.equal(maximumPreview.scores.length, 2048)
  assert.equal(maximumPreview.iterations, 40)
  assert.equal(
    WEIGHTED_PREVIEW_ALWAYS_ASYNC,
    true,
    `the UI must retain progress/cancel even when this host happens to finish in ${elapsedMs.toFixed(2)} ms`
  )
  console.log(
    `weighted-prior 2048-entry canonicalization + Merkle + 40-iteration preview: ${elapsedMs.toFixed(3)} ms; UI policy=async-worker-progress-cancel`
  )
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
