import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { formatProposalActions } from './gov-actions'

test('proposal action formatting preserves nonempty and empty descriptions', () => {
  assert.deepEqual(
    formatProposalActions([
      {
        target: '0x1111111111111111111111111111111111111111',
        value: 42n,
        data: '0x1234',
        operation: 0,
        description: 'Transfer the reviewed amount',
      },
      {
        target: '0x2222222222222222222222222222222222222222',
        value: 0n,
        data: '0xabcd',
        operation: 1,
        description: '',
      },
    ]),
    [
      {
        target: '0x1111111111111111111111111111111111111111',
        value: '42',
        data: '0x1234',
        operation: 0,
        description: 'Transfer the reviewed amount',
      },
      {
        target: '0x2222222222222222222222222222222222222222',
        value: '0',
        data: '0xabcd',
        operation: 1,
        description: '',
      },
    ]
  )
})

test('setup recovery and the live handler share the complete action formatter', () => {
  const source = readFileSync(new URL('./gov.ts', import.meta.url), 'utf8')
  assert.equal(
    [...source.matchAll(/formatProposalActions\(actions\)/g)].length,
    2,
    'both proposal ingestion paths must preserve the full action tuple'
  )
})
