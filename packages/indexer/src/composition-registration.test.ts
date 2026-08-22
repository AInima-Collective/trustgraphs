import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

const sourceDirectory = new URL('.', import.meta.url)
const eventName = 'compositionMerkleSnapshot:CheckpointParamsPinned'
const registrationPattern = new RegExp(
  `ponder\\.on\\(\\s*['"]${eventName}['"]`,
  'g'
)

test('composition checkpoint pins have one handler that updates both histories', () => {
  const registrations = readdirSync(sourceDirectory)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .flatMap((name) => {
      const source = readFileSync(new URL(name, sourceDirectory), 'utf8')
      return [...source.matchAll(registrationPattern)].map(() => ({
        name,
        source,
      }))
    })

  assert.equal(
    registrations.length,
    1,
    `${eventName} must have exactly one Ponder indexing function`
  )
  assert.match(registrations[0]!.source, /update\(parameterVersion/)
  assert.match(registrations[0]!.source, /update\(compositionPolicyVersion/)
})
