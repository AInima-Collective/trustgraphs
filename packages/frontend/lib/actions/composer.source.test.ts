import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

const form = source('components/CreateProposalForm.tsx')
const editor = source('components/GovernanceActionEditor.tsx')
const profile = source('app/networks/[id]/settings/profile.tsx')
const scoring = source('app/networks/[id]/settings/scoring.tsx')
const settings = source('app/networks/[id]/settings/component.tsx')
const weighted = source('app/create/weighted/workspace.tsx')

assert.match(form, /governanceComposerRegistry\.filter/)
assert.match(form, /<optgroup/)
assert.match(form, /moveDraft\(index, -1\)/)
assert.match(form, /moveDraft\(index, 1\)/)
assert.match(form, /removeDraft\(index\)/)
assert.match(form, /encodeGovernanceActionDraft/)
assert.match(form, /Live encoded preview/)
assert.match(form, /Copy DAO proposal JSON/)
assert.match(editor, /case 'update-scoring-params'/)
assert.match(editor, /case 'update-network-profile'/)
assert.match(editor, /case 'set-signer-sync-paused'/)
assert.match(editor, /case 'rotate-weighted-prior'/)
assert.match(editor, /case 'send-erc20'/)
assert.match(editor, /case 'fund-rewards'/)
assert.match(editor, /case 'set-operational-role'/)
assert.match(editor, /case 'set-governance-quorum'/)
assert.match(editor, /case 'set-governance-delegatecall-target'/)
assert.match(form, /High-impact governance action/)

for (const producer of [profile, scoring, settings, weighted]) {
  assert.match(producer, /version: 2/)
  assert.match(producer, /actionKey:/)
  assert.match(producer, /values:/)
}
assert.doesNotMatch(profile, /parentHash: ZERO_HASH/)
assert.doesNotMatch(settings, /parentHash: ZERO_HASH/)
assert.doesNotMatch(weighted, /actions: \[\s*\{\s*target:/)

console.log('governance composer UI and typed prefill producers: ok')
