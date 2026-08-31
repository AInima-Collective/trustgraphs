import assert from 'node:assert/strict'

import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
  zeroAddress,
} from 'viem'

import {
  governanceCancelProposalAction,
  governanceDelegateCallTargetAction,
  governanceExecutionDelayAction,
  governanceQuorumAction,
  governanceVotingDelayAction,
  governanceVotingPeriodAction,
} from './governance'
import {
  cancelConstitutionalTransferAction,
  constitutionalTransferAction,
  operationalRoleAction,
} from './membership'
import { walkGovernanceActions } from './registry'
import {
  erc20TransferAction,
  rewardDistributionAction,
  rewardsAllowlistAction,
  rewardsDistributorAllowanceAction,
  rewardsFeePercentageAction,
  rewardsFeeRecipientAction,
  rewardsPauseAction,
} from './treasury'
import type {
  GovernanceActionContext,
  GovernanceActionDefinition,
  SafeAction,
} from './types'

const address = (byte: string) => getAddress(`0x${byte.repeat(40)}`) as Address
const bytes32 = (byte: string) => `0x${byte.repeat(64)}` as const

const context: GovernanceActionContext = {
  snapshot: address('1'),
  treasurySafe: address('2'),
  fundDistributor: address('3'),
  governanceModule: address('4'),
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
  const matched = walkGovernanceActions(encoded, context)
  assert.equal(matched.length, 1, definition.key)
  assert.equal(matched[0]!.definition.key, definition.key)
  assert.deepEqual(matched[0]!.values, values)
  assert.deepEqual(
    definition.encode(matched[0]!.values as Values, context).map(tuple),
    encoded.map(tuple)
  )
  return encoded
}

roundTrip(erc20TransferAction, {
  token: address('5'),
  recipient: address('6'),
  amount: '1234567',
})

const erc20Rewards = roundTrip(rewardDistributionAction, {
  token: address('5'),
  amount: '5000000',
  expectedRoot: bytes32('a'),
  expectedTotalMerkleValue: '1000000000000000000',
  claimDeadline: '0',
  maxFeeAmount: '125000',
  expectedFeeRecipient: address('7'),
})
assert.equal(erc20Rewards.length, 2)

const ethRewards = roundTrip(rewardDistributionAction, {
  token: zeroAddress,
  amount: '1000000000000000000',
  expectedRoot: bytes32('b'),
  expectedTotalMerkleValue: '2000000000000000000',
  claimDeadline: '2000000000',
  maxFeeAmount: '10000000000000000',
  expectedFeeRecipient: address('7'),
})
assert.equal(ethRewards.length, 1)
assert.equal(ethRewards[0]!.value, '1000000000000000000')
assert.deepEqual(
  walkGovernanceActions(
    [{ ...ethRewards[0]!, target: address('f') }],
    context
  ).map((entry) => entry.definition.key),
  ['custom']
)
assert.deepEqual(
  walkGovernanceActions(
    [erc20Rewards[0]!, { ...erc20Rewards[1]!, target: address('f') }],
    context
  ).map((entry) => entry.definition.key),
  ['custom', 'custom']
)

const verifyTrusted = <Values>(
  definition: GovernanceActionDefinition<Values>,
  values: Values
) => {
  const encoded = roundTrip(definition, values)
  const spoofed = encoded.map((action, index) =>
    index === encoded.length - 1 ? { ...action, target: address('f') } : action
  )
  assert.ok(
    walkGovernanceActions(spoofed, context).every(
      (entry) => entry.definition.key === 'custom'
    ),
    `${definition.key} must fail closed for a spoofed target`
  )
}

verifyTrusted(rewardsPauseAction, { paused: true })
verifyTrusted(rewardsFeeRecipientAction, { recipient: address('7') })
verifyTrusted(rewardsFeePercentageAction, {
  feePercentage: '25000000000000000',
})
verifyTrusted(rewardsAllowlistAction, { enabled: true })
verifyTrusted(rewardsDistributorAllowanceAction, {
  distributor: address('8'),
  allowed: true,
})
verifyTrusted(governanceQuorumAction, { quorum: '150000000000000000' })
verifyTrusted(governanceVotingDelayAction, { blocks: '10' })
verifyTrusted(governanceVotingPeriodAction, { blocks: '7200' })
verifyTrusted(governanceExecutionDelayAction, { blocks: '300' })
verifyTrusted(governanceDelegateCallTargetAction, {
  target: address('9'),
  allowed: true,
})
verifyTrusted(governanceCancelProposalAction, { proposalId: '42' })
verifyTrusted(operationalRoleAction, {
  account: address('a'),
  granted: true,
})
verifyTrusted(constitutionalTransferAction, { successor: address('b') })
verifyTrusted(cancelConstitutionalTransferAction, {})
roundTrip(rewardsPauseAction, { paused: false })
roundTrip(operationalRoleAction, {
  account: address('a'),
  granted: false,
})
roundTrip(governanceVotingDelayAction, { blocks: '0' })
roundTrip(governanceExecutionDelayAction, { blocks: '0' })

const accessControlAbi = parseAbi([
  'function grantRole(bytes32 role, address account)',
])
const wrongRole: SafeAction = {
  target: context.snapshot!,
  value: '0',
  data: encodeFunctionData({
    abi: accessControlAbi,
    functionName: 'grantRole',
    args: [bytes32('c'), address('a')],
  }),
  operation: 0,
}
assert.equal(
  walkGovernanceActions([wrongRole], context)[0]!.definition.key,
  'custom',
  'role management must recognize only the authenticated operational role'
)

const wrongApproval = [
  {
    ...erc20Rewards[0]!,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [context.fundDistributor!, 1n],
    }),
  },
  erc20Rewards[1]!,
]
assert.deepEqual(
  walkGovernanceActions(wrongApproval, context).map(
    (entry) => entry.definition.key
  ),
  ['custom', 'custom'],
  'a reward span must bind approval amount to the distribution'
)

assert.throws(
  () => governanceQuorumAction.encode({ quorum: '0' }, context),
  /positive/
)
assert.throws(
  () =>
    governanceQuorumAction.encode({ quorum: '1000000000000000001' }, context),
  /on-chain range/
)
assert.throws(
  () => governanceVotingPeriodAction.encode({ blocks: '0' }, context),
  /positive/
)
assert.throws(
  () =>
    constitutionalTransferAction.encode(
      { successor: context.treasurySafe! },
      context
    ),
  /differ from/
)
assert.throws(
  () =>
    rewardDistributionAction.encode(
      {
        token: zeroAddress,
        amount: '1',
        expectedRoot: '0x1234',
        expectedTotalMerkleValue: '1',
        claimDeadline: '0',
        maxFeeAmount: '0',
        expectedFeeRecipient: address('7'),
      },
      context
    ),
  /32-byte hex/
)

assert.equal(constitutionalTransferAction.danger, true)
assert.equal(governanceDelegateCallTargetAction.danger, true)
assert.equal(governanceCancelProposalAction.danger, true)

console.log('governance M3 action round trips and target verification: ok')
