import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./gov.ts', import.meta.url), 'utf8')
const shared = readFileSync(
  new URL('./gov-module-shared.ts', import.meta.url),
  'utf8'
)
const governed = readFileSync(
  new URL('./governed.ts', import.meta.url),
  'utf8'
)

test('governed module updates create the birth row before an earlier constructor log updates it', () => {
  // The ensure path exists and delegates to the shared find-then-materialize helper.
  assert.match(source, /async function ensureMerkleGovModule/)
  assert.match(
    source,
    /async function ensureMerkleGovModule[\s\S]*?ensureMerkleGovModuleRow\(/
  )
  assert.match(shared, /db\.find\(table, \{ address \}\)/)
  assert.match(
    shared,
    /if \(existing\) return[\s\S]*await readMerkleGovModuleRow\(client, address\)[\s\S]*onConflictDoNothing\(\)/
  )

  // Every module-row update goes ensure-first.
  assert.match(
    source,
    /async function updateMerkleGovModule[\s\S]*await ensureMerkleGovModule\(context, address\)[\s\S]*\.update\(merkleGovModule, \{ address \}\)/
  )

  const constructorUpdate = source.match(
    /const merkleSnapshotContractUpdated[\s\S]*?\n\}/
  )?.[0]
  assert.ok(constructorUpdate)
  assert.match(constructorUpdate, /await updateMerkleGovModule/)
  assert.doesNotMatch(constructorUpdate, /\.update\(merkleGovModule/)
  assert.match(source, /'governedMerkleGovModule:MerkleSnapshotContractUpdated'/)
})

test('all module-row mutations use the ensure-before-update path', () => {
  assert.equal(
    [...source.matchAll(/\.update\(merkleGovModule, /g)].length,
    1,
    'only updateMerkleGovModule may update the module table directly'
  )
})

test('discovery and ensure share one read-back so both birth paths write identical rows', () => {
  assert.match(governed, /readMerkleGovModuleRow\(context\.client, moduleAddress\)/)
  assert.doesNotMatch(
    governed,
    /functionName: 'avatar'/,
    'governed.ts must not duplicate the module read-back'
  )
  assert.match(source, /await readMerkleGovModuleRow\(context\.client, address\)/)
})

test('merkleGovModule:setup names a stale statically configured address instead of a silent catch', () => {
  const setup = source.match(
    /ponder\.on\('merkleGovModule:setup'[\s\S]*?\n\}\)/
  )?.[0]
  assert.ok(setup)
  assert.doesNotMatch(setup, /catch \{/)
  assert.match(setup, /catch \(error\)/)
  assert.match(setup, /console\.warn\([\s\S]*?\$\{address\}/)
})
