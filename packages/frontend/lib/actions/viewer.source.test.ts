import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

const viewer = source('components/ProposalActionList.tsx')
const simulation = source('components/ProposalScoringSimulation.tsx')
const card = source('components/ProposalCard.tsx')
const scoring = source('app/networks/[id]/settings/scoring.tsx')
const governance = source('hooks/useGovernance.ts')
const prefill = source('lib/governance-prefill.ts')
const indexer = source('../indexer/src/gov-actions.ts')

assert.match(viewer, /walkGovernanceActions\(actions, context\)/)
assert.match(viewer, /governanceActionContextFor\(network\)/)
assert.doesNotMatch(viewer, /decodeParameterUpdateAction/)
assert.doesNotMatch(viewer, /proposalDiffLines/)
assert.doesNotMatch(viewer, /proposalDescription/)

assert.match(simulation, /walkGovernanceActions\(actions, context\)/)
assert.match(simulation, /selectProposalBaselineVersion/)
assert.doesNotMatch(simulation, /description\.match/)
assert.doesNotMatch(simulation, /parentHashFromDescription/)
assert.doesNotMatch(card, /proposalDescription=/)
assert.match(scoring, /const proposalDescription = rationale\.trim\(\)/)

assert.match(governance, /export type ProposalAction = SafeAction/)
assert.match(prefill, /export type GovernancePrefillAction = SafeAction &/)
assert.match(indexer, /import type \{ SafeAction \}/)
assert.match(indexer, /Omit<\s*SafeAction,/)

console.log(
  'governance viewer uses authenticated actions and canonical types: ok'
)
