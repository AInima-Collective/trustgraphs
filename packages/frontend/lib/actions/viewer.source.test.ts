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
const queries = source('queries/ponder.ts')
const indexer = source('../indexer/src/gov-actions.ts')
const govIndexer = source('../indexer/src/gov.ts')

assert.match(viewer, /walkGovernanceActions\(displayActions, context\)/)
assert.match(viewer, /governanceActionContextFor\(network\)/)
assert.match(viewer, /normalizeSafeActions\(actions\)/)
assert.doesNotMatch(viewer, /decodeParameterUpdateAction/)
assert.doesNotMatch(viewer, /proposalDiffLines/)
assert.doesNotMatch(viewer, /proposalDescription/)
assert.match(viewer, /case 'fund-rewards'/)
assert.match(viewer, /case 'set-operational-role'/)
assert.match(viewer, /case 'set-governance-quorum'/)
assert.match(viewer, /matched\.definition\.danger/)

assert.match(
  simulation,
  /walkGovernanceActions\(\s*normalizedActions\.actions,\s*context\s*\)/
)
assert.match(simulation, /reconstructProposalBaseline/)
assert.match(simulation, /reconstruction\?\.status === 'verified'/)
assert.doesNotMatch(simulation, /selectProposalBaselineVersion/)
assert.doesNotMatch(simulation, /description\.match/)
assert.doesNotMatch(simulation, /parentHashFromDescription/)
assert.doesNotMatch(card, /proposalDescription=/)
assert.match(scoring, /const proposalDescription = rationale\.trim\(\)/)

assert.match(governance, /export type ProposalAction = SafeAction/)
assert.match(governance, /normalizeSafeActions\(proposal\.actions\)/)
assert.match(
  prefill,
  /export type GovernancePrefillAction = GovernanceActionDraft/
)
assert.match(prefill, /const parseV2Actions/)
assert.match(prefill, /const migrateLegacyActions/)
assert.match(prefill, /parseGovernancePrefill\(raw, networkId, fingerprint\)/)
assert.match(queries, /getProofSubmissionsBefore:/)
assert.match(queries, /lt\(t\.blockNumber, options\.proposalBlock\)/)
assert.match(queries, /limit: 2/)
assert.match(govIndexer, /blockNumber: 0n/)
assert.match(indexer, /import type \{ SafeAction \}/)
assert.match(indexer, /Omit<\s*SafeAction,/)

console.log(
  'governance viewer uses authenticated actions and canonical types: ok'
)
