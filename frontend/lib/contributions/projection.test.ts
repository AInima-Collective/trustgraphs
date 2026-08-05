/** Parity guard for the exact score-to-pool projection rendered by the round page. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { Hex } from 'viem'

import { computeContributions } from './compute'
import { projectContributionPool } from './projection'
import { ContributionsParams } from './types'
import { RawEdge } from '../pagerank/types'

type JsonEdge = Omit<RawEdge, 'kind' | 'blockTimestamp'> & {
  kind: number | string
  blockTimestamp: string
}
type JsonParams = Omit<
  ContributionsParams,
  | 'dampingFp'
  | 'toleranceFp'
  | 'minWeightFp'
  | 'maxWeightFp'
  | 'trustMultiplierFp'
  | 'trustShareFp'
  | 'trustDecayFp'
  | 'precisionScale'
  | 'roundStart'
  | 'roundEnd'
  | 'unacceptedMultFp'
  | 'collaboratorMultFp'
  | 'minRaterRepFp'
  | 'totalPool'
> & {
  dampingFp: string
  toleranceFp: string
  minWeightFp: string
  maxWeightFp: string
  trustMultiplierFp: string
  trustShareFp: string
  trustDecayFp: string
  precisionScale: string
  roundStart: string
  roundEnd: string
  unacceptedMultFp: string
  collaboratorMultFp: string
  minRaterRepFp: string
  totalPool: string
}
type Golden = {
  compute: {
    input: {
      trustEdges: JsonEdge[]
      records: JsonEdge[]
      params: JsonParams
    }
  }
}

const golden = JSON.parse(
  readFileSync('../test/golden/contributions.json', 'utf8')
) as Golden
const jsonParams = golden.compute.input.params
const params: ContributionsParams = {
  dampingFp: BigInt(jsonParams.dampingFp),
  toleranceFp: BigInt(jsonParams.toleranceFp),
  maxIterations: Number(jsonParams.maxIterations),
  minWeightFp: BigInt(jsonParams.minWeightFp),
  maxWeightFp: BigInt(jsonParams.maxWeightFp),
  trustMultiplierFp: BigInt(jsonParams.trustMultiplierFp),
  trustShareFp: BigInt(jsonParams.trustShareFp),
  trustDecayFp: BigInt(jsonParams.trustDecayFp),
  trustedSeeds: jsonParams.trustedSeeds as Hex[],
  precisionScale: BigInt(jsonParams.precisionScale),
  weightFieldIndex: Number(jsonParams.weightFieldIndex),
  roundStart: BigInt(jsonParams.roundStart),
  roundEnd: BigInt(jsonParams.roundEnd),
  unacceptedMultFp: BigInt(jsonParams.unacceptedMultFp),
  collaboratorMultFp: BigInt(jsonParams.collaboratorMultFp),
  minRaterRepFp: BigInt(jsonParams.minRaterRepFp),
  evaluatorCarveoutBps: Number(jsonParams.evaluatorCarveoutBps),
  totalPool: BigInt(jsonParams.totalPool),
  claimSchemaUid: jsonParams.claimSchemaUid as Hex,
  responseSchemaUid: jsonParams.responseSchemaUid as Hex,
  valuationSchemaUid: jsonParams.valuationSchemaUid as Hex,
}
const edge = (value: JsonEdge): RawEdge => ({
  ...value,
  kind: Number(value.kind),
  blockTimestamp: BigInt(value.blockTimestamp),
})

const recompute = computeContributions({
  trustEdges: golden.compute.input.trustEdges.map(edge),
  records: golden.compute.input.records.map(edge),
  params,
})
const projected = projectContributionPool(
  recompute.claimScores,
  params.totalPool
)

assert.deepEqual(
  projected.map(({ claimUid, scoreFp, shareBps, payout }) => ({
    claimUid,
    scoreFp: scoreFp.toString(),
    shareBps: shareBps.toString(),
    payout: payout.toString(),
  })),
  [
    {
      claimUid: `0x${'01'.repeat(32)}`,
      scoreFp: '506824390837398103',
      shareBps: '6747',
      payout: '3373642554',
    },
    {
      claimUid: `0x${'05'.repeat(32)}`,
      scoreFp: '127318578491555229',
      shareBps: '1694',
      payout: '847487575',
    },
    {
      claimUid: `0x${'02'.repeat(32)}`,
      scoreFp: '68631029410138147',
      shareBps: '913',
      payout: '456837842',
    },
    {
      claimUid: `0x${'03'.repeat(32)}`,
      scoreFp: '48379068918605035',
      shareBps: '646',
      payout: '322032029',
    },
  ]
)
assert.equal(
  projected.reduce((sum, entry) => sum + entry.payout, 0n),
  params.totalPool
)
assert.equal(
  projected.reduce((sum, entry) => sum + entry.shareBps, 0n),
  10_000n
)

console.log('contributions page projection parity guard PASS')
