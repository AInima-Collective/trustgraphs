import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
const workspace = read('app/create/composition/workspace.tsx')
const catalogRoute = read('app/compositions/page.tsx')
const networkDirectory = read('app/networks/page.tsx')
const directoryServer = read('lib/directory.server.ts')
const instance = read('app/compositions/[instanceId]/instance.tsx')
const governance = read('app/compositions/[instanceId]/governance.tsx')
const governanceLayout = read('app/networks/[id]/governance/layout.tsx')
const settings = read('app/networks/[id]/settings/page.tsx')
const profileSettings = read('app/networks/[id]/settings/profile.tsx')
const contributionsPage = read('app/networks/[id]/contributions.tsx')
const contributionsCatalog = read('lib/contributions-catalog.ts')
const compositionNetwork = read('lib/composition/network.ts')
const epoch = read(
  'app/compositions/[instanceId]/epochs/[checkpointId]/epoch.tsx'
)
const policy = read(
  'app/compositions/[instanceId]/policies/[version]/policy.tsx'
)
// The chooser owns the program links since the create flow reorganization split the wizard
// from program selection.
const create = read('app/create/chooser.tsx')
const truthCopy = read('lib/composition/preflight.ts')
const errorCopy = read('lib/error.ts')
const contracts = read('lib/composition/contracts.ts')
const combined = [
  workspace,
  instance,
  governance,
  epoch,
  policy,
  truthCopy,
].join('\n')

assert.match(
  workspace,
  /aria-labelledby=\{embedded \? undefined : 'composition-title'\}/
)
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
assert.doesNotMatch(workspace, /captureBlock: 0n/)
assert.match(workspace, /compositionSimplex/)
assert.match(workspace, /Prepare this source/)
assert.match(workspace, /Prepare selected sources/)
assert.match(workspace, /successful sources[\s\S]*stay prepared/)
assert.match(workspace, /deployAdapters\(missingAdapters\)/)
assert.match(workspace, /update\.familyId !== undefined/)
assert.match(workspace, /COMPOSITION_OUTPUT_KIND/)
assert.match(workspace, /Finish the required creation details/)
assert.match(workspace, /transactionBlockers\.map/)
assert.match(workspace, /Ready to simulate the exact transaction/)
assert.match(workspace, /Simulation is the required final check/)
assert.match(workspace, /disabled=\{busy \|\| !readyToSimulate\}/)
assert.match(workspace, /withFund && !withGovernance/)
assert.match(workspace, /if \(next\) setWithGovernance\(true\)/)
assert.match(workspace, /withFund && withGovernance/)
assert.match(workspace, /Couldn&apos;t continue/)
assert.match(workspace, /setTransactionProblem\(parseErrorMessage\(error\)\)/)
assert.match(workspace, /compositionSourceAdapters\(previewConfig\.sources\)/)
assert.match(workspace, /\[overflow-wrap:anywhere\]/)
assert.doesNotMatch(workspace, /Your wallet owns the fund/)
assert.match(errorCopy, /invaliddistributorsafe/)
assert.match(errorCopy, /0x39d5d230/)
assert.match(errorCopy, /adapterpolicymismatch/)
assert.match(errorCopy, /0x6eb8d307/)
assert.match(contracts, /compositionSourceAdapters[\s\S]*sort/)
assert.match(workspace, /simulateContract/)
assert.match(workspace, /simulatedPayloadHash/)
assert.match(workspace, /Cancel pending/)
assert.match(workspace, /Activate exact preimage/)
assert.match(workspace, /conservative trust-compose band-3 fee/)
assert.match(workspace, /Wallet rejection does not discard it/)
assert.match(truthCopy, /raw point total/)
assert.match(truthCopy, /Weights are governance choices/)
assert.match(truthCopy, /separate trust-compose program/)
assert.match(workspace, /Publisher\/controller family/)
assert.match(workspace, /Pairwise support\/correlation\/disagreement/)
assert.match(workspace, /Per-account exact attribution/)

// Governance and the shared fund are explicit creation-time choices with
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
assert.match(workspace, /value: prepayWei/)
assert.match(workspace, /configurePaidRefreshes/)
assert.match(workspace, /functionName: 'setPolicy'/)
assert.match(workspace, /Approve the second transaction/)
assert.match(workspace, /Enable paid score refreshes/)
assert.match(workspace, /funded, but paid refreshes are disabled/)
assert.match(contracts, /function setPolicy\(bytes32 instanceId/)
// Mixed admission: standard and weighted sources blend in one composition, so
// a cross-type pick keeps the current selection and the picker never offers a
// clearing "switch score type" action.
assert.match(
  workspace,
  /Standard and weighted-score\s+graphs blend in one composition/
)
assert.match(workspace, /cross-type pick keeps the current selection/)
assert.doesNotMatch(workspace, /Use this score type/)
assert.doesNotMatch(workspace, /clears the current source/)
assert.match(workspace, /creationParamsVersion/)
assert.match(workspace, /trustComposeFactoryV2Abi/)
assert.match(contracts, /sourceCompatibilityClass/)
assert.doesNotMatch(workspace, /I explicitly acknowledge/)
assert.match(workspace, /DISABLED_SIGNER_SYNC/)

// Composition creation uses the same public profile as a standard or weighted Trustgraph. The
// exact pinned URI is included in the payload that is simulated before signing.
assert.match(workspace, /<NetworkProfileFields/)
assert.match(workspace, /hasNetworkProfile\(profile\)/)
assert.match(workspace, /await pinMetadata\(metadata\)/)
assert.match(workspace, /metadataURI: await ensureMetadataURI\(\)/)
assert.match(settings, /NetworkProfileSettings/)
assert.match(settings, /SnapshotProfileSettings/)
assert.match(settings, /governanceNetworkId: parentId/)
assert.match(profileSettings, /target\.governanceNetworkId \?\? target\.id/)
assert.match(governanceLayout, /compositionAsNetwork/)
assert.match(governanceLayout, /NetworkProvider network=\{compositionNetwork\}/)
assert.match(contributionsPage, /Manage round profile/)
assert.match(contributionsCatalog, /BigInt\(row\.metadataRevision\) > 0n/)
assert.match(contributionsCatalog, /governance: row\.governance/)
assert.match(compositionNetwork, /metadataRevision: instance\.metadataRevision/)
assert.match(
  compositionNetwork,
  /merkleGovModule: instance\.governance\.module/
)

// Receipt scanning is topic-keyed (parseEventLogs), never filtered by emitting address: under
// the governed wrapper the base factory emits the creation event and the Safe is the creator.
assert.match(workspace, /parseEventLogs/)
assert.doesNotMatch(
  workspace,
  /log\.address\.toLowerCase\(\)\s*[!=]==\s*factory\.toLowerCase\(\)/
)

assert.match(create, /href="\/create\/composition"/)
assert.match(catalogRoute, /redirect\('\/networks'\)/)
assert.doesNotMatch(networkDirectory, /href="\/compositions"/)
assert.match(directoryServer, /program: 'trust-compose'/)
assert.match(directoryServer, /`\/networks\/\$\{source\.id\}`/)
assert.match(instance, /CompositionNetworkHeader/)
assert.match(instance, /Network members/)
assert.match(instance, /Score history/)
assert.match(governance, /Policy history/)
assert.match(governance, /Changes are managed from Settings/)
assert.match(workspace, /embedded/)
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
