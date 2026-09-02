import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8')

const config = read('../ponder.config.ts')
const handlers = read('./authority.ts')

test('live admin indexing covers initial controllers for every program and migrated authorities', () => {
  for (const source of [
    'paramsAuthorityTrustgraphsController',
    'paramsAuthorityWeightedController',
    'paramsAuthorityCompositionController',
    'paramsAuthorityContributionsController',
    'paramsAuthorityMigratedController',
  ]) {
    assert.match(config, new RegExp(`${source}: \\{`))
    assert.match(handlers, new RegExp(`${source}:OwnershipTransferred`))
  }
  assert.match(config, /address: paramsControllers\(\)/)
  assert.match(config, /address: weightedParamsControllers\(\)/)
  assert.match(config, /address: compositionControllers\(\)/)
  assert.match(config, /address: contributionsControllers\(\)/)
  assert.match(config, /address: migratedParamsControllers\(\)/)
})
