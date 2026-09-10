import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { getAddress } from 'viem'

import {
  type GovernanceActionContext,
  type GovernanceActionDraft,
  encodeGovernanceActionDraft,
  walkGovernanceActions,
} from '../lib/actions'

const address = (digit: string) => getAddress(`0x${digit.repeat(40)}`)
const bytes32 = (digit: string) => `0x${digit.repeat(64)}` as const

const context: GovernanceActionContext = {
  snapshot: address('1'),
  treasurySafe: address('2'),
  fundDistributor: address('3'),
  governanceModule: address('4'),
}

type FixtureSource = {
  name: string
  draft: GovernanceActionDraft
  /** The leg whose authenticated target is replaced by the spoof-target test. */
  spoofActionIndex?: number
}

const fixtures: FixtureSource[] = [
  {
    name: 'send ETH',
    draft: {
      actionKey: 'send-eth',
      values: { recipient: address('6'), amountEth: '1.25' },
    },
  },
  {
    name: 'send ERC-20',
    draft: {
      actionKey: 'send-erc20',
      values: {
        token: address('5'),
        recipient: address('6'),
        amountBaseUnits: '1234567',
      },
    },
  },
  {
    name: 'fund ERC-20 rewards',
    draft: {
      actionKey: 'fund-rewards',
      values: {
        token: address('5'),
        amountBaseUnits: '5000000',
        expectedRoot: bytes32('a'),
        expectedTotalMerkleValue: '1000000000000000000',
        claimDeadline: '2000000000',
        maxFeeAmount: '125000',
        expectedFeeRecipient: address('7'),
      },
    },
    spoofActionIndex: 1,
  },
  {
    name: 'pause rewards',
    draft: {
      actionKey: 'set-rewards-paused',
      values: { paused: true },
    },
    spoofActionIndex: 0,
  },
  {
    name: 'set rewards fee recipient',
    draft: {
      actionKey: 'set-rewards-fee-recipient',
      values: { recipient: address('7') },
    },
    spoofActionIndex: 0,
  },
  {
    name: 'set rewards fee percentage',
    draft: {
      actionKey: 'set-rewards-fee-percentage',
      values: { feePercent: '2.5' },
    },
    spoofActionIndex: 0,
  },
  {
    name: 'enable rewards allowlist',
    draft: {
      actionKey: 'set-rewards-allowlist-enabled',
      values: { enabled: true },
    },
    spoofActionIndex: 0,
  },
  {
    name: 'allow rewards funder',
    draft: {
      actionKey: 'set-rewards-distributor-allowance',
      values: { distributor: address('8'), allowed: true },
    },
    spoofActionIndex: 0,
  },
  {
    name: 'update network profile',
    draft: {
      actionKey: 'update-network-profile',
      values: { metadataURI: 'ipfs://bafy-wave-one-network-profile' },
    },
    spoofActionIndex: 0,
  },
  {
    name: 'grant operational role',
    draft: {
      actionKey: 'set-operational-role',
      values: { account: address('a'), granted: true },
    },
    spoofActionIndex: 0,
  },
  {
    name: 'propose constitutional transfer',
    draft: {
      actionKey: 'propose-constitutional-transfer',
      values: { successor: address('b') },
    },
    spoofActionIndex: 0,
  },
  {
    name: 'cancel constitutional transfer',
    draft: {
      actionKey: 'cancel-constitutional-transfer',
      values: {},
    },
    spoofActionIndex: 0,
  },
  {
    name: 'set governance quorum',
    draft: {
      actionKey: 'set-governance-quorum',
      values: { quorumPercent: '15' },
    },
    spoofActionIndex: 0,
  },
  {
    name: 'set governance voting delay',
    draft: {
      actionKey: 'set-governance-voting-delay',
      values: { blocks: '10' },
    },
    spoofActionIndex: 0,
  },
  {
    name: 'set governance voting period',
    draft: {
      actionKey: 'set-governance-voting-period',
      values: { blocks: '7200' },
    },
    spoofActionIndex: 0,
  },
  {
    name: 'set governance execution delay',
    draft: {
      actionKey: 'set-governance-execution-delay',
      values: { blocks: '300' },
    },
    spoofActionIndex: 0,
  },
  {
    name: 'allow governance delegatecall target',
    draft: {
      actionKey: 'set-governance-delegatecall-target',
      values: { target: address('9'), allowed: true },
    },
    spoofActionIndex: 0,
  },
  {
    name: 'cancel governance proposal',
    draft: {
      actionKey: 'cancel-governance-proposal',
      values: { proposalId: '42' },
    },
    spoofActionIndex: 0,
  },
]

const main = async () => {
  const cases = []
  for (const fixture of fixtures) {
    const actions = await encodeGovernanceActionDraft(fixture.draft, context)
    const matched = walkGovernanceActions(actions, context).map((entry) => ({
      actionKey: entry.definition.key,
      values: entry.values,
      consumed: entry.consumed,
    }))
    cases.push({ ...fixture, actions, matched })
  }

  const corpus = { version: 1, context, cases }
  const fixturePath = fileURLToPath(
    new URL('../lib/actions/fixtures/wave-one.json', import.meta.url)
  )

  if (process.argv.includes('--write')) {
    writeFileSync(fixturePath, `${JSON.stringify(corpus, null, 2)}\n`)
    return
  }
  if (process.argv.includes('--check')) {
    const committed = JSON.parse(readFileSync(fixturePath, 'utf8'))
    if (JSON.stringify(committed) !== JSON.stringify(corpus)) {
      throw new Error(
        'Governance action fixtures are stale; run pnpm fixtures:governance-actions:write'
      )
    }
    return
  }

  process.stdout.write(`${JSON.stringify(corpus, null, 2)}\n`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
