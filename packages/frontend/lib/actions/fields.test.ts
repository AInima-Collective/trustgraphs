import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Address } from 'viem'

import {
  type GovernanceActionContext,
  type GovernanceActionDraft,
  GovernanceActionFieldError,
  defaultGovernanceActionValues,
  encodeGovernanceActionDraft,
  governanceComposerRegistry,
} from './index'
import {
  formatGovernanceFieldValue,
  governanceActionFields,
  validateGovernanceActionDraft,
  validateGovernanceFieldValue,
} from './fields'
import {
  blocksForSeconds,
  formatBlockCount,
  formatBps,
  formatPercent18,
  formatTokenAmount,
  formatUnixSeconds,
  formatUsd8,
  formatWei,
} from './format'

const address = (byte: string) => `0x${byte.repeat(40)}` as Address

const context: GovernanceActionContext = {
  snapshot: address('1'),
  treasurySafe: address('2'),
  fundDistributor: address('3'),
  governanceModule: address('4'),
}

/** Keys the editor or a prefill producer may attach without a rendered field. */
const HIDDEN_KEYS = new Set([
  'previewAddress',
  'resolvedAddresses',
  'parentParams',
  'parentEpochLength',
])

const main = async () => {
  for (const definition of governanceComposerRegistry) {
    const fields = governanceActionFields(definition.key)
    const defaults = defaultGovernanceActionValues(definition.key) as Record<
      string,
      unknown
    >
    const keys = new Set(fields.map((field) => field.key))
    assert.equal(keys.size, fields.length, `${definition.key}: duplicate key`)
    for (const key of Object.keys(defaults)) {
      assert.ok(
        keys.has(key) || HIDDEN_KEYS.has(key),
        `${definition.key}: default value ${key} has no field`
      )
    }
    for (const field of fields) {
      if (field.required && !field.advanced) {
        assert.ok(
          field.key in defaults,
          `${definition.key}: required field ${field.key} has no default`
        )
      }
      assert.ok(field.label.trim(), `${definition.key}: ${field.key} label`)
      if (field.kind === 'amount') {
        assert.ok(field.token, `${definition.key}: amount needs token info`)
      }
      if (field.kind === 'boolean') {
        assert.ok(field.options, `${definition.key}: boolean needs options`)
      }
    }
  }

  // Every golden draft passes schema validation, so the schema never rejects a known-good draft.
  const fixture = JSON.parse(
    readFileSync(
      join(process.cwd(), 'lib', 'actions', 'fixtures', 'wave-one.json'),
      'utf8'
    )
  ) as { cases: { name: string; draft: GovernanceActionDraft }[] }
  for (const entry of fixture.cases) {
    assert.deepEqual(
      validateGovernanceActionDraft(entry.draft.actionKey, entry.draft.values),
      {},
      `fixture ${entry.name} should validate`
    )
  }

  // Field-level checks.
  const field = (
    kind: Parameters<typeof validateGovernanceFieldValue>[0]['kind']
  ) => ({ key: 'x', label: 'X', kind, required: true }) as const
  assert.equal(validateGovernanceFieldValue(field('address'), ''), 'Required.')
  assert.equal(
    validateGovernanceFieldValue(field('address'), 'alice.eth'),
    null
  )
  assert.equal(
    validateGovernanceFieldValue(field('address'), address('a')),
    null
  )
  assert.match(
    validateGovernanceFieldValue(field('address'), 'nope')!,
    /address/
  )
  assert.equal(validateGovernanceFieldValue(field('percent'), '2.5'), null)
  assert.match(validateGovernanceFieldValue(field('percent'), '150')!, /exceed/)
  assert.match(
    validateGovernanceFieldValue(field('percent'), '100.5')!,
    /exceed/
  )
  assert.equal(validateGovernanceFieldValue(field('percent'), '100'), null)
  assert.match(
    validateGovernanceFieldValue(field('timestamp'), 'soon')!,
    /whole/
  )
  assert.equal(validateGovernanceFieldValue(field('timestamp'), '0'), null)
  assert.match(
    validateGovernanceFieldValue(field('bytes32'), '0x12')!,
    /32 bytes/
  )
  assert.equal(
    validateGovernanceFieldValue(field('bytes32'), `0x${'ab'.repeat(32)}`),
    null
  )
  assert.match(
    validateGovernanceFieldValue(field('bytes'), '0x123')!,
    /byte-aligned/
  )
  assert.equal(validateGovernanceFieldValue(field('bytes'), '0x'), null)
  assert.match(validateGovernanceFieldValue(field('uri'), 'bafy…')!, /ipfs/)
  assert.equal(validateGovernanceFieldValue(field('uri'), 'ipfs://bafy'), null)
  assert.equal(
    validateGovernanceFieldValue({ ...field('uri'), required: false }, ''),
    null
  )
  assert.equal(
    validateGovernanceFieldValue(field('boolean'), 'true'),
    'Choose one option.'
  )
  assert.equal(
    validateGovernanceFieldValue(field('address-list'), [address('a'), 'x']),
    'Entry 2 is not a valid address.'
  )
  assert.deepEqual(
    validateGovernanceActionDraft('send-erc20', {
      token: 'nope',
      recipient: '',
      amountBaseUnits: '1.5',
    }),
    {
      token: 'Enter a valid address or ENS name.',
      recipient: 'Required.',
      amountBaseUnits: 'Enter a whole number.',
    }
  )

  // Formatting.
  assert.equal(
    formatTokenAmount('1234567', { decimals: 6, symbol: 'USDC' }),
    '1.234567 USDC'
  )
  assert.equal(
    formatTokenAmount('1500000000', { decimals: 6, symbol: 'USDC' }),
    '1,500 USDC'
  )
  assert.equal(formatTokenAmount('1234567'), '1,234,567 base units')
  assert.equal(formatWei('1250000000000000000'), '1.25 ETH')
  assert.equal(formatPercent18('25000000000000000'), '2.5%')
  assert.equal(formatPercent18('1000000000000000000'), '100%')
  assert.equal(formatBps('1500'), '15%')
  assert.equal(formatBps('1'), '0.01%')
  assert.equal(formatUsd8('25000000000'), '$250.00')
  assert.equal(formatUsd8('123456789'), '$1.23456789')
  assert.equal(formatUnixSeconds('0', { zeroLabel: 'No expiry' }), 'No expiry')
  assert.equal(
    formatUnixSeconds('2000000000', { now: 2000000000 - 3 * 86400 }),
    '2033-05-18 03:33 UTC (in ~3 days)'
  )
  assert.equal(
    formatUnixSeconds('2000000000', { now: 2000000000 + 7200 }),
    '2033-05-18 03:33 UTC (~2 hours ago)'
  )
  assert.equal(formatBlockCount('14400'), '14,400 blocks (~2 days)')
  assert.equal(formatBlockCount('1'), '1 block (moments)')
  assert.equal(formatBlockCount('0'), '0 blocks')
  assert.equal(blocksForSeconds(2 * 86400), 14400n)
  assert.equal(blocksForSeconds(13), 2n)

  const amountField = governanceActionFields('send-erc20').find(
    (entry) => entry.key === 'amountBaseUnits'
  )!
  assert.equal(
    formatGovernanceFieldValue(
      amountField,
      '5000000',
      { token: address('5') },
      { tokens: () => ({ decimals: 6, symbol: 'USDC' }) }
    ),
    '5 USDC'
  )
  assert.equal(
    formatGovernanceFieldValue(amountField, '5000000', { token: address('5') }),
    '5,000,000 base units'
  )
  const deadline = governanceActionFields('fund-rewards').find(
    (entry) => entry.key === 'claimDeadline'
  )!
  assert.equal(formatGovernanceFieldValue(deadline, '0'), 'No expiry')
  const paused = governanceActionFields('set-rewards-paused')[0]!
  assert.equal(
    formatGovernanceFieldValue(paused, true),
    'Pause funding and claims'
  )

  // Encoding reports the offending field.
  await assert.rejects(
    encodeGovernanceActionDraft(
      {
        actionKey: 'send-erc20',
        values: {
          token: 'nope',
          recipient: address('6'),
          amountBaseUnits: '1',
        },
      },
      context
    ),
    (error: unknown) =>
      error instanceof GovernanceActionFieldError && error.field === 'token'
  )
  await assert.rejects(
    encodeGovernanceActionDraft(
      {
        actionKey: 'fund-rewards',
        values: {
          ...(defaultGovernanceActionValues('fund-rewards') as object),
          amountBaseUnits: '1',
          expectedRoot: '0x12',
          expectedTotalMerkleValue: '1',
          expectedFeeRecipient: address('7'),
        },
      },
      context
    ),
    (error: unknown) =>
      error instanceof GovernanceActionFieldError &&
      error.field === 'expectedRoot'
  )
  await assert.rejects(
    encodeGovernanceActionDraft(
      {
        actionKey: 'custom',
        values: {
          target: address('9'),
          valueEth: '0',
          data: '0x',
          operation: 0,
          description: '',
        },
      },
      context
    ),
    (error: unknown) =>
      error instanceof GovernanceActionFieldError &&
      error.field === 'description'
  )

  // ENS names resolve on every address field, not only the ETH recipient.
  const resolved: string[] = []
  const resolver = async (identifier: string, preview?: Address | null) => {
    resolved.push(`${identifier}:${preview ?? ''}`)
    return { address: address('c'), ensName: identifier }
  }
  const fee = await encodeGovernanceActionDraft(
    {
      actionKey: 'set-rewards-fee-recipient',
      values: {
        recipient: 'treasury.eth',
        resolvedAddresses: { recipient: address('c') },
      },
    },
    context,
    resolver
  )
  assert.equal(fee.length, 1)
  assert.deepEqual(resolved, [`treasury.eth:${address('c')}`])
  assert.match(fee[0]!.data, new RegExp(address('c').slice(2)))
  const transfer = await encodeGovernanceActionDraft(
    {
      actionKey: 'send-eth',
      values: {
        recipient: 'alice.eth',
        amountEth: '1',
        previewAddress: address('c'),
      },
    },
    context,
    resolver
  )
  assert.equal(transfer[0]!.target, address('c'))
  assert.match(transfer[0]!.description!, /alice\.eth/)
  await assert.rejects(
    encodeGovernanceActionDraft(
      {
        actionKey: 'set-rewards-fee-recipient',
        values: { recipient: 'treasury.eth' },
      },
      context
    ),
    (error: unknown) =>
      error instanceof GovernanceActionFieldError && error.field === 'recipient'
  )

  console.log('governance field schema, validation and formatting: ok')
}

void main()
