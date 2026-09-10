import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8')

const governed = read('./governed.ts')
const schema = read('../ponder.schema.ts')
const abi = read('../abis/subnetwork.ts')

test('queued recovery actions are indexed with their lifecycle', () => {
  assert.match(abi, /event RecoveryScheduled\(bytes32 indexed actionId/)
  assert.match(abi, /event RecoveryCancelled\(bytes32 indexed actionId/)
  assert.match(abi, /event RecoveryExecuted\(bytes32 indexed actionId/)
  assert.match(schema, /export const recoveryAction = onchainTable\(/)
  assert.match(
    schema,
    /status: t\.text\(\)\.notNull\(\), \/\/ scheduled \| cancelled \| executed/
  )
  assert.match(governed, /'delayedRecoveryModule:RecoveryScheduled'/)
  assert.match(governed, /'delayedRecoveryModule:RecoveryCancelled'/)
  assert.match(governed, /'delayedRecoveryModule:RecoveryExecuted'/)
})

test('recovery actions are only recorded for factory-recorded modules', () => {
  // The scheduled handler looks the module up in recoveryAuthority before inserting, so an
  // unrelated contract emitting the same event never lands in the table.
  const scheduled = governed.slice(
    governed.indexOf("'delayedRecoveryModule:RecoveryScheduled'"),
    governed.indexOf('const settleRecoveryAction')
  )
  assert.match(scheduled, /context\.db\.find\(recoveryAuthority/)
  assert.match(scheduled, /if \(!recovery\) return/)
  assert.match(scheduled, /instanceId: recovery\.instanceId/)
  assert.match(scheduled, /onConflictDoNothing\(\)/)
})
