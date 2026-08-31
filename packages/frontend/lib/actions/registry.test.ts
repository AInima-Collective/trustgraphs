import assert from 'node:assert/strict'

import type { Address, Hex } from 'viem'

import { paramsHash } from '../pagerank/encode'
import type { Params } from '../pagerank/types'
import { PARAMS_SCALE, serializeParams } from '../scoring-params'
import { customAction } from './custom'
import { governanceActionContextFor } from './network'
import { walkGovernanceActions } from './registry'
import { scoringParamsAction, signerParamsAction } from './scoring'
import { selectProposalBaselineVersion } from './scoring-history'
import { ethTransferAction } from './transfer'
import type { GovernanceActionContext, SafeAction } from './types'

const address = (byte: string) => `0x${byte.repeat(40)}` as Address
const bytes32 = (byte: string) => `0x${byte.repeat(64)}` as Hex

const proposed: Params = {
  dampingFp: 800_000_000_000_000_000n,
  toleranceFp: 1_000_000_000_000n,
  maxIterations: 120,
  minWeightFp: PARAMS_SCALE,
  maxWeightFp: 100n * PARAMS_SCALE,
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

const context: GovernanceActionContext = {
  paramsController: address('4'),
  signerSyncModule: address('5'),
}

assert.deepEqual(
  governanceActionContextFor({
    contracts: {
      merkleSnapshot: address('1'),
      easIndexerResolver: address('2'),
      trustgraphsParamsController: context.paramsController,
      safe: {
        proxy: address('3'),
        signerSyncManager: context.signerSyncModule,
      },
    },
  }),
  context
)

const encoded = scoringParamsAction.encode(
  { proposed, evidenceURI: 'ipfs://evidence', syncSigner: true },
  context
)
assert.equal(encoded.length, 2)

const coordinated = walkGovernanceActions(encoded, context)
assert.equal(coordinated.length, 1)
assert.equal(coordinated[0]!.definition.key, 'update-scoring-params')
assert.equal(coordinated[0]!.consumed, 2)
const coordinatedValues = coordinated[0]!.values as {
  proposed: Params
  evidenceURI: string
  syncSigner: boolean
}
assert.equal(coordinatedValues.syncSigner, true)
assert.equal(coordinatedValues.evidenceURI, 'ipfs://evidence')
assert.equal(
  serializeParams(coordinatedValues.proposed),
  serializeParams(proposed)
)

const roundTrip = scoringParamsAction.encode(coordinatedValues, context)
assert.deepEqual(
  roundTrip.map(({ target, value, data, operation }) => ({
    target,
    value,
    data,
    operation,
  })),
  encoded.map(({ target, value, data, operation }) => ({
    target,
    value,
    data,
    operation,
  }))
)

// A real selector on an attacker's contract must never receive the friendly scoring rendering.
const spoofedController: SafeAction = {
  ...encoded[1]!,
  target: address('9'),
}
const spoofed = walkGovernanceActions([spoofedController], context)
assert.equal(spoofed[0]!.definition.key, 'custom')

const spoofedSigner: SafeAction = {
  ...encoded[0]!,
  target: address('8'),
}
assert.equal(
  walkGovernanceActions([spoofedSigner], context)[0]!.definition.key,
  'custom'
)

// Span matching is consecutive. An intervening call prevents false correlation.
const transfer = ethTransferAction.encode(
  { recipient: address('6'), value: '1000000000000000000' },
  context
)[0]!
const separated = walkGovernanceActions(
  [encoded[0]!, transfer, encoded[1]!],
  context
)
assert.deepEqual(
  separated.map((entry) => entry.definition.key),
  ['set-signer-params-hash', 'send-eth', 'update-scoring-params']
)

const signerOnly = signerParamsAction.encode(
  { paramsHash: paramsHash(proposed) },
  context
)
assert.equal(
  walkGovernanceActions(signerOnly, context)[0]!.definition.key,
  'set-signer-params-hash'
)

const decodedTransfer = walkGovernanceActions([transfer], context)[0]!
assert.equal(decodedTransfer.definition.key, 'send-eth')
assert.deepEqual(decodedTransfer.values, {
  recipient: address('6'),
  value: '1000000000000000000',
  description: undefined,
})

const raw: SafeAction = {
  target: address('7'),
  value: '0',
  data: '0x1234',
  operation: 1,
  description: 'Untrusted annotation',
}
const fallback = walkGovernanceActions([raw], context)
assert.equal(fallback[0]!.definition, customAction)
assert.deepEqual(fallback[0]!.values, raw)

assert.throws(
  () =>
    walkGovernanceActions([raw], context, [
      {
        key: 'broken',
        category: 'custom',
        label: 'Broken',
        summary: 'Invalid matcher result',
        match: () => ({ values: null, consumed: 0 }),
      },
    ]),
  /No governance action matched/
)

const baseline = selectProposalBaselineVersion(
  [
    { version: '4', executedAtBlock: '40', valid: true },
    { version: '3', executedAtBlock: '30', valid: false },
    { version: '2', executedAtBlock: '20', valid: true },
    { version: '1', executedAtBlock: '10', valid: true },
  ],
  35n
)
assert.equal(baseline?.version, '2')
assert.equal(
  selectProposalBaselineVersion(
    [
      { version: '1', executedAtBlock: '10', valid: true },
      { version: '2', executedAtBlock: '10', valid: true },
    ],
    10n
  )?.version,
  '2'
)
assert.equal(
  selectProposalBaselineVersion(
    [{ version: '1', executedAtBlock: '10', valid: true }],
    9n
  ),
  undefined
)
assert.equal(
  selectProposalBaselineVersion(
    [
      { version: '1', executedAtBlock: 'not-a-block', valid: true },
      { version: 'invalid', executedAtBlock: '10', valid: true },
    ],
    10n
  ),
  undefined
)

console.log('governance action registry matching and target verification: ok')
