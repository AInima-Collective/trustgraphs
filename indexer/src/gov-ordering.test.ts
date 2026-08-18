import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./gov.ts', import.meta.url), 'utf8')

test('governed module updates create the birth row before an earlier constructor log updates it', () => {
  assert.match(source, /async function ensureMerkleGovModule/)
  assert.match(source, /context\.db\.find\(merkleGovModule, \{ address \}\)/)
  assert.match(
    source,
    /if \(existing\) return[\s\S]*await insertMerkleGovModule\(context, address\)/
  )
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
  assert.match(
    source,
    /'governedMerkleGovModule:MerkleSnapshotContractUpdated'/
  )
})

test('all module-row mutations use the ensure-before-update path', () => {
  assert.equal(
    [...source.matchAll(/\.update\(merkleGovModule, /g)].length,
    1,
    'only updateMerkleGovModule may update the module table directly'
  )
})
