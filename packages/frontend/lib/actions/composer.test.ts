import assert from 'node:assert/strict'

import type { Address } from 'viem'

import {
  encodeGovernanceActionDraft,
  governanceComposerActionAvailable,
} from './composer'
import type { GovernanceActionContext } from './types'

const address = (byte: string) => `0x${byte.repeat(40)}` as Address
const bytes32 = (byte: string) => `0x${byte.repeat(64)}`

const context: GovernanceActionContext = {
  snapshot: address('1'),
  paramsController: address('2'),
  signerSyncModule: address('3'),
}

const main = async () => {
  assert.equal(governanceComposerActionAvailable('send-eth', context), true)
  assert.equal(
    governanceComposerActionAvailable('rotate-weighted-prior', context),
    false
  )

  const transfer = await encodeGovernanceActionDraft(
    {
      actionKey: 'send-eth',
      values: { recipient: address('4'), amountEth: '1.25' },
    },
    context
  )
  assert.equal(transfer[0]!.value, '1250000000000000000')

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
    context
  )
  assert.equal(weighted[0]!.target, address('5'))

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
