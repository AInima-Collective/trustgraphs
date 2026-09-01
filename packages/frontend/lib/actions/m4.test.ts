import assert from 'node:assert/strict'

import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  zeroAddress,
} from 'viem'

import { contributionsFactoryAbi } from '../contributions-factory'
import {
  compositionPolicyAction,
  compositionPolicyCancelAction,
} from './composition'
import { createContributionRoundAction } from './programs'
import { walkGovernanceActions } from './registry'
import {
  recoveryCancelAction,
  recoveryProposerAction,
  safeDisableModuleAction,
  safeEnableModuleAction,
  safeGuardAction,
  safeSwapOwnerAction,
  snapshotAccumulatorAction,
  snapshotAnchorRegistryAction,
  snapshotVerifierAction,
} from './safety'
import type {
  GovernanceActionContext,
  GovernanceActionDefinition,
  SafeAction,
} from './types'
import {
  vaultPolicyAction,
  vaultWithdrawalCancelAction,
  vaultWithdrawalExecuteAction,
  vaultWithdrawalRequestAction,
} from './vault'
import { weightedPriorCancelAction } from './weighted'

const address = (byte: string) => getAddress(`0x${byte.repeat(40)}`) as Address
const bytes32 = (byte: string) => `0x${byte.repeat(64)}` as Hex

const context: GovernanceActionContext = {
  instanceId: bytes32('1'),
  snapshot: address('2'),
  treasurySafe: address('3'),
  weightedParamsController: address('4'),
  compositionParamsController: address('5'),
  provingVault: address('6'),
  contributionsFactory: address('7'),
  recoveryModule: address('a'),
}

const tuple = (action: SafeAction) => ({
  target: action.target,
  value: action.value,
  data: action.data,
  operation: action.operation,
})

const roundTrip = <Values>(
  definition: GovernanceActionDefinition<Values>,
  values: Values
) => {
  const encoded = definition.encode(values, context)
  const [matched] = walkGovernanceActions(encoded, context)
  assert.equal(matched?.definition.key, definition.key)
  assert.deepEqual(matched?.values, values)
  assert.deepEqual(
    definition.encode(matched!.values as Values, context).map(tuple),
    encoded.map(tuple)
  )

  const spoofed = encoded.map((action) => ({
    ...action,
    target: address('f'),
  }))
  assert.ok(
    walkGovernanceActions(spoofed, context).every(
      (entry) => entry.definition.key === 'custom'
    ),
    `${definition.key} must fail closed for a spoofed target`
  )
}

roundTrip(snapshotVerifierAction, { address: address('8') })
roundTrip(snapshotAccumulatorAction, { address: address('9') })
roundTrip(snapshotAnchorRegistryAction, { address: address('a') })
roundTrip(safeEnableModuleAction, { address: address('b') })
roundTrip(safeGuardAction, { address: zeroAddress })
roundTrip(safeDisableModuleAction, {
  previousModule: address('c'),
  module: address('d'),
})
roundTrip(safeSwapOwnerAction, {
  previousOwner: address('c'),
  oldOwner: address('d'),
  newOwner: address('e'),
})
roundTrip(recoveryProposerAction, { address: address('b') })
roundTrip(recoveryCancelAction, { actionId: bytes32('d') })
roundTrip(vaultPolicyAction, {
  minPaidIntervalBlocks: '300',
  maxPerRootUsd: '250000000',
})
roundTrip(vaultWithdrawalRequestAction, {
  ethAmount: '1000000000000000000',
  usdcAmount: '5000000',
})
roundTrip(vaultWithdrawalCancelAction, {})
roundTrip(vaultWithdrawalExecuteAction, { recipient: address('8') })
roundTrip(weightedPriorCancelAction, {})
roundTrip(compositionPolicyAction, {
  manifest: '0x1234',
  adapters: [address('8'), address('9')],
  metadataDigest: bytes32('a'),
})
roundTrip(compositionPolicyCancelAction, {})

const parentParams = {
  dampingFp: '850000000000000000',
  toleranceFp: '1000000000000',
  maxIterations: 100,
  minWeightFp: '1000000000000000000',
  maxWeightFp: '100000000000000000000',
  trustShareFp: '500000000000000000',
  trustDecayFp: '800000000000000000',
  trustedSeeds: [address('8')],
  totalPool: '1000000000000000000000000',
  precisionScale: '1000000000000000000',
  schemaUid: bytes32('b'),
  weightFieldIndex: 1,
  envelope0DomainSeparators: [],
  lane2MaxHeadAge: '0',
  accumulator: address('9'),
  chainId: '11155111',
}

const round = createContributionRoundAction.encode(
  {
    parentParams,
    parentEpochLength: '10',
    name: 'Autumn round',
    roundStart: '2000000000',
    roundEnd: '2000100000',
    totalPool: '1000000',
    evaluatorCarveoutBps: '100',
    distributorToken: zeroAddress,
    salt: bytes32('c'),
  },
  context
)
const [matchedRound] = walkGovernanceActions(round, context)
assert.equal(matchedRound?.definition.key, 'create-contribution-round')
assert.equal((matchedRound?.values as { name: string }).name, 'Autumn round')
assert.equal(
  walkGovernanceActions(round, { ...context, instanceId: bytes32('f') })[0]!
    .definition.key,
  'custom',
  'a child round must name the network currently being viewed as its parent'
)
const decodedRound = decodeFunctionData({
  abi: contributionsFactoryAbi,
  data: round[0]!.data,
})
assert.equal(decodedRound.functionName, 'createInstance')
if (decodedRound.functionName !== 'createInstance') {
  throw new Error('round action decoded as the wrong function')
}
const attackerAdminRound = {
  ...round[0]!,
  data: encodeFunctionData({
    abi: contributionsFactoryAbi,
    functionName: 'createInstance',
    args: [{ ...decodedRound.args[0], admin: address('f') }],
  }),
}
assert.equal(
  walkGovernanceActions([attackerAdminRound], context)[0]!.definition.key,
  'custom',
  'a governed child round must leave admin zero so the parent Safe owns it'
)

assert.equal(vaultWithdrawalRequestAction.danger, true)
assert.equal(snapshotVerifierAction.danger, true)
assert.equal(safeEnableModuleAction.danger, true)

console.log('governance M4 actions round trip and fail closed: ok')
