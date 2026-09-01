import assert from 'node:assert/strict'

import type { Address } from 'viem'

import {
  encodeGovernanceActionDraft,
  governanceComposerActionAvailable,
  governanceComposerRegistry,
} from './composer'
import { governanceActionRegistry } from './registry'
import type { GovernanceActionContext } from './types'

const address = (byte: string) => `0x${byte.repeat(40)}` as Address
const bytes32 = (byte: string) => `0x${byte.repeat(64)}`

const context: GovernanceActionContext = {
  snapshot: address('1'),
  paramsController: address('2'),
  signerSyncModule: address('3'),
  treasurySafe: address('4'),
  fundDistributor: address('5'),
  governanceModule: address('6'),
}

const main = async () => {
  for (const composerDefinition of governanceComposerRegistry) {
    const viewerDefinition = governanceActionRegistry.find(
      (definition) => definition.key === composerDefinition.key
    )
    assert.ok(
      viewerDefinition,
      `${composerDefinition.key} must have a viewer matcher`
    )
    assert.equal(
      !!viewerDefinition.danger,
      composerDefinition.danger,
      `${composerDefinition.key} danger framing must agree in both modes`
    )
  }

  assert.equal(governanceComposerActionAvailable('send-eth', context), true)
  assert.equal(
    governanceComposerActionAvailable('rotate-weighted-prior', context),
    false
  )
  assert.equal(governanceComposerActionAvailable('fund-rewards', context), true)
  assert.equal(
    governanceComposerActionAvailable('set-governance-quorum', context),
    true
  )

  const transfer = await encodeGovernanceActionDraft(
    {
      actionKey: 'send-eth',
      values: { recipient: address('4'), amountEth: '1.25' },
    },
    context
  )
  assert.equal(transfer[0]!.value, '1250000000000000000')

  const tokenTransfer = await encodeGovernanceActionDraft(
    {
      actionKey: 'send-erc20',
      values: {
        token: address('7'),
        recipient: address('8'),
        amountBaseUnits: '1234567',
      },
    },
    context
  )
  assert.equal(tokenTransfer[0]!.target, address('7'))

  const rewards = await encodeGovernanceActionDraft(
    {
      actionKey: 'fund-rewards',
      values: {
        token: address('7'),
        amountBaseUnits: '5000000',
        expectedRoot: bytes32('b'),
        expectedTotalMerkleValue: '1000000000000000000',
        claimDeadline: '0',
        maxFeeAmount: '125000',
        expectedFeeRecipient: address('9'),
      },
    },
    context
  )
  assert.equal(rewards.length, 2)
  assert.equal(rewards[1]!.target, context.fundDistributor)

  const quorum = await encodeGovernanceActionDraft(
    {
      actionKey: 'set-governance-quorum',
      values: { quorumPercent: '15' },
    },
    context
  )
  assert.equal(quorum[0]!.target, context.governanceModule)

  await assert.rejects(
    () =>
      encodeGovernanceActionDraft(
        {
          actionKey: 'set-rewards-fee-percentage',
          values: { feePercent: '100.1' },
        },
        context
      ),
    /on-chain range/
  )

  const profile = await encodeGovernanceActionDraft(
    {
      actionKey: 'update-network-profile',
      values: { metadataURI: 'ipfs://profile' },
    },
    context
  )
  assert.equal(profile[0]!.target, context.snapshot)

  const pause = await encodeGovernanceActionDraft(
    {
      actionKey: 'set-signer-sync-paused',
      values: { paused: true },
    },
    context
  )
  assert.equal(pause[0]!.target, context.signerSyncModule)

  const weighted = await encodeGovernanceActionDraft(
    {
      actionKey: 'rotate-weighted-prior',
      values: {
        controller: address('5'),
        manifest: '0x1234',
        metadataDigest: bytes32('a'),
      },
    },
    { ...context, weightedParamsController: address('5') }
  )
  assert.equal(weighted[0]!.target, address('5'))

  await assert.rejects(
    () =>
      encodeGovernanceActionDraft(
        {
          actionKey: 'rotate-weighted-prior',
          values: {
            controller: address('7'),
            manifest: '0x1234',
            metadataDigest: bytes32('a'),
          },
        },
        { ...context, weightedParamsController: address('5') }
      ),
    /does not match/
  )

  await assert.rejects(
    () =>
      encodeGovernanceActionDraft(
        {
          actionKey: 'custom',
          values: {
            target: address('6'),
            valueEth: '0',
            data: 'not-hex',
            operation: 0,
            description: 'Invalid calldata',
          },
        },
        context
      ),
    /Calldata must be valid/
  )

  console.log('governance composer typed draft encoding: ok')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
