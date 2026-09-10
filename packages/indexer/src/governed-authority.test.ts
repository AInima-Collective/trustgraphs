import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8')

const governed = read('./governed.ts')
const schema = read('../ponder.schema.ts')
const instances = read('./api/instances.ts')
const weighted = read('./api/weighted-priors.ts')
const compositions = read('./api/compositions.ts')

test('governed discovery authenticates recovery and guard addresses through authorityOf', () => {
  assert.match(governed, /functionName: 'authorityOf'/)
  assert.match(governed, /address: event\.log\.address/)
  assert.match(governed, /args: \[instanceId\]/)
  assert.match(governed, /recoveryModule: authority\.recoveryModule/)
  assert.match(governed, /executionGuard: authority\.executionGuard/)
})

test('every governed catalog exposes the authenticated recovery and guard addresses', () => {
  assert.match(schema, /recoveryModule: t\.hex\(\)/)
  assert.match(schema, /executionGuard: t\.hex\(\)/)
  for (const api of [instances, weighted, compositions]) {
    assert.match(api, /recoveryModule: merkleGovModule\.recoveryModule/)
    assert.match(api, /executionGuard: merkleGovModule\.executionGuard/)
  }
})
