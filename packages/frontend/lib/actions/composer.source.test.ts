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
const composition = source('app/create/composition/workspace.tsx')
const contributions = source(
  'app/networks/[id]/contributions/new/component.tsx'
)

assert.match(form, /governanceComposerRegistry\.filter/)
const library = source('components/GovernanceActionLibrary.tsx')
const proposalPage = source('app/networks/[id]/governance/new/component.tsx')
const governancePage = source('app/networks/[id]/governance/page.tsx')
assert.match(form, /GovernanceActionLibrary/)
assert.match(library, /Search actions/)
assert.match(library, /Filter actions by category/)
assert.match(proposalPage, /loadGovernancePrefill/)
assert.match(proposalPage, /clearGovernancePrefill/)
assert.doesNotMatch(governancePage, /CreateProposalForm|createModal/)
assert.match(form, /moveDraft\(index, -1\)/)
assert.match(form, /moveDraft\(index, 1\)/)
assert.match(form, /removeDraft\(index\)/)
assert.match(form, /encodeGovernanceActionDraft/)
assert.match(form, /Live encoded preview/)
assert.match(form, /Copy DAO proposal JSON/)
// The editor is schema-driven: every action's fields come from lib/actions/fields.ts, and
// the few actions with derived or structured values keep dedicated editors.
assert.match(editor, /governanceActionFields\(/)
assert.match(editor, /GovernanceFieldGrid/)
assert.match(editor, /ScoringParamsEditor/)
assert.match(editor, /case 'update-scoring-params'/)
assert.match(editor, /case 'create-contribution-round'/)
assert.match(editor, /case 'rotate-weighted-prior'/)
assert.match(editor, /case 'propose-composition-policy'/)
assert.match(editor, /case 'disable-safe-module'/)
assert.match(editor, /case 'swap-safe-owner'/)
assert.doesNotMatch(editor, /Unix seconds/)
assert.doesNotMatch(editor, /base units\)/)
assert.match(form, /GovernanceComposerProvider/)
assert.match(form, /validateGovernanceActionDraft/)
assert.match(form, /fieldErrors=\{fieldErrorsFor\(draft, result\)\}/)
assert.match(form, /showAllErrors=\{attemptedReview\}/)
const fields = source('lib/actions/fields.ts')
for (const kind of [
  "kind: 'timestamp'",
  "kind: 'blocks'",
  "kind: 'amount'",
  "kind: 'percent'",
  "kind: 'bps'",
  "kind: 'usd'",
  "picker: 'score-root'",
  "picker: 'safe-owner'",
  "picker: 'safe-module'",
  "picker: 'proposal'",
]) {
  assert.ok(fields.includes(kind), `fields.ts declares ${kind}`)
}
assert.match(form, /High-impact governance action/)

for (const producer of [
  profile,
  scoring,
  settings,
  weighted,
  composition,
  contributions,
]) {
  assert.match(producer, /version: 2/)
  assert.match(producer, /actionKey:/)
  assert.match(producer, /values:/)
}
assert.doesNotMatch(profile, /parentHash: ZERO_HASH/)
assert.doesNotMatch(settings, /parentHash: ZERO_HASH/)
assert.doesNotMatch(weighted, /actions: \[\s*\{\s*target:/)
assert.match(weighted, /actionKey: 'cancel-weighted-prior'/)
assert.match(composition, /actionKey: 'propose-composition-policy'/)
assert.match(composition, /actionKey: 'cancel-composition-policy'/)
assert.match(composition, /actionKey: 'set-vault-policy'/)
assert.match(contributions, /actionKey: 'create-contribution-round'/)

console.log('governance composer UI and typed prefill producers: ok')
