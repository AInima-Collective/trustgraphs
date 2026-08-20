import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
const workspace = read('app/create/composition/workspace.tsx')
const catalog = read('app/compositions/catalog.tsx')
const instance = read('app/compositions/[instanceId]/instance.tsx')
const epoch = read(
  'app/compositions/[instanceId]/epochs/[checkpointId]/epoch.tsx'
)
const policy = read(
  'app/compositions/[instanceId]/policies/[version]/policy.tsx'
)
const create = read('app/create/component.tsx')
const truthCopy = read('lib/composition/preflight.ts')
const combined = [workspace, catalog, instance, epoch, policy, truthCopy].join(
  '\n'
)

assert.match(workspace, /<main[^>]+aria-labelledby="composition-title"/)
assert.match(workspace, /fetchCompositionCandidates/)
assert.match(workspace, /requireCompatibleCandidate/)
assert.match(workspace, /provenanceEnabled/)
assert.match(workspace, /getStateAtIndex/)
assert.match(workspace, /getStateProvenance/)
// The picker pre-reads eligibility from the chain and says why a candidate is not selectable
// (including the permanent 'locked' verdict) instead of erroring after a click.
assert.match(workspace, /classifySourceEligibility/)
assert.match(workspace, /getStateCount/)
assert.match(workspace, /sourceEligibility\?\.detail/)
assert.match(workspace, /exactEqualWeights/)
assert.match(workspace, /computeCompositionPreview/)
assert.match(workspace, /compositionSimplex/)
assert.match(workspace, /Deploy reviewed adapter/)
assert.match(workspace, /simulateContract/)
assert.match(workspace, /simulatedPayloadHash/)
assert.match(workspace, /Cancel pending/)
assert.match(workspace, /Activate exact preimage/)
assert.match(workspace, /conservative trust-compose band-3 fee/)
assert.match(workspace, /Fail-closed capture/)
assert.match(workspace, /Wallet rejection does not discard it/)
assert.match(truthCopy, /raw point total/)
assert.match(truthCopy, /Weights are governance choices/)
assert.match(truthCopy, /separate trust-compose program/)
assert.match(workspace, /Publisher\/controller family/)
assert.match(workspace, /Pairwise support\/correlation\/disagreement/)
assert.match(workspace, /Per-account exact attribution/)

// Creation-time features (GOAL M4/M5): governance and the shared fund are explicit choices with
// plain-words copy, the voting profile is read live from the wrapper factory, the compounded
// activation timelock is stated, and signer-sync is honestly not offered.
assert.match(workspace, /Create with governance/)
assert.match(workspace, /A Safe is a shared onchain account/)
assert.match(workspace, /useAuthorityProfile/)
assert.match(workspace, /read live from the governed factory/)
assert.match(workspace, /POLICY_ACTIVATION_DELAY/)
assert.match(workspace, /Score-selected Safe signers are not offered/)
assert.match(workspace, /Add a shared fund/)
assert.match(workspace, /withDistributor: withFund/)
assert.match(workspace, /Pay for score refreshes up front\?/)
assert.match(workspace, /DISABLED_SIGNER_SYNC/)

// Receipt scanning is topic-keyed (parseEventLogs), never filtered by emitting address: under
// the governed wrapper the base factory emits the creation event and the Safe is the creator.
assert.match(workspace, /parseEventLogs/)
assert.doesNotMatch(
  workspace,
  /log\.address\.toLowerCase\(\)\s*[!=]==\s*factory\.toLowerCase\(\)/
)

assert.match(create, /href="\/create\/composition"/)
assert.match(catalog, /href="\/create\/composition"/)
assert.match(instance, /Governed policy history/)
assert.match(instance, /Proved epoch history/)
assert.match(epoch, /Complete evidence bundle/)
assert.match(epoch, /Address allocation proof/)
assert.match(epoch, /Cryptographic provenance/)
assert.match(epoch, /Governance provenance/)
assert.match(epoch, /byte-identical to the landed bundle/)
assert.match(policy, /Activation preimage/)
assert.match(policy, /Pending, cancelled|status/)

// Forbidden affirmative product claims. Negated explanatory copy remains allowed.
assert.doesNotMatch(combined, />\s*Merged edges\s*</i)
assert.doesNotMatch(combined, />\s*Inherited prior\s*</i)
assert.doesNotMatch(combined, />\s*Objective truth\s*</i)
assert.doesNotMatch(
  combined,
  /proof (?:shows|proves) (?:the )?weights (?:are )?wise/i
)

console.log(
  'composition workspace semantics, controls, lifecycle, durable routes, proofs, and copy: ok'
)
