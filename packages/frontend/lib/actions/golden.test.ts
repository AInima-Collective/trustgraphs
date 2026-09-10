import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { getAddress } from 'viem'

import {
  type GovernanceActionDraft,
  encodeGovernanceActionDraft,
} from './composer'
import { normalizeSafeActions } from './normalize'
import { walkGovernanceActions } from './registry'
import type { GovernanceActionContext, SafeAction } from './types'

type GoldenCase = {
  name: string
  draft: GovernanceActionDraft
  spoofActionIndex?: number
  actions: SafeAction[]
  matched: { actionKey: string; values: unknown; consumed: number }[]
}

type GoldenCorpus = {
  version: number
  context: GovernanceActionContext
  cases: GoldenCase[]
}

const corpus = JSON.parse(
  readFileSync(
    path.resolve(process.cwd(), 'lib/actions/fixtures/wave-one.json'),
    'utf8'
  )
) as GoldenCorpus

const WAVE_ONE_KEYS = [
  'send-eth',
  'send-erc20',
  'fund-rewards',
  'set-rewards-paused',
  'set-rewards-fee-recipient',
  'set-rewards-fee-percentage',
  'set-rewards-allowlist-enabled',
  'set-rewards-distributor-allowance',
  'update-network-profile',
  'set-operational-role',
  'propose-constitutional-transfer',
  'cancel-constitutional-transfer',
  'set-governance-quorum',
  'set-governance-voting-delay',
  'set-governance-voting-period',
  'set-governance-execution-delay',
  'set-governance-delegatecall-target',
  'cancel-governance-proposal',
] as const

const summarize = (actions: SafeAction[], context: GovernanceActionContext) =>
  walkGovernanceActions(actions, context).map((entry) => ({
    actionKey: entry.definition.key,
    values: entry.values,
    consumed: entry.consumed,
  }))

const run = async () => {
  assert.equal(corpus.version, 1)
  assert.deepEqual(
    corpus.cases.map((fixture) => fixture.draft.actionKey),
    WAVE_ONE_KEYS,
    'every wave-one action has one fixture in the review order'
  )

  for (const fixture of corpus.cases) {
    const encoded = await encodeGovernanceActionDraft(
      fixture.draft,
      corpus.context
    )
    assert.deepEqual(
      encoded,
      fixture.actions,
      `${fixture.name}: encoded calldata`
    )

    // Exercise the same neutral JSON boundary used by proposal storage and the indexer API.
    const transported = JSON.parse(JSON.stringify(fixture.actions)) as unknown
    const normalized = normalizeSafeActions(transported)
    assert.equal(
      normalized.ok,
      true,
      `${fixture.name}: neutral tuple transport`
    )
    if (!normalized.ok) continue
    assert.deepEqual(
      summarize(normalized.actions, corpus.context),
      fixture.matched,
      `${fixture.name}: decoded presentation`
    )

    if (fixture.spoofActionIndex !== undefined) {
      const spoofed = normalized.actions.map((action, index) =>
        index === fixture.spoofActionIndex
          ? { ...action, target: getAddress(`0x${'f'.repeat(40)}`) }
          : action
      )
      assert.ok(
        summarize(spoofed, corpus.context).every(
          (entry) => entry.actionKey !== fixture.draft.actionKey
        ),
        `${fixture.name}: spoofed authenticated target must not get the friendly decoder`
      )
    }
  }

  console.log('governance wave-one golden compose/decode corpus: ok')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
