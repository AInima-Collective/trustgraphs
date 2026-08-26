import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(
  join(process.cwd(), 'app/create/weighted/workspace.tsx'),
  'utf8'
)

// The create route and the Settings embed share exact import/preview primitives while rendering
// as distinct journeys. The create route never offers an existing-network picker or update mode.
assert.match(source, /rotationInstanceId\?: Hex/)
assert.match(source, /const Root = administrative \? 'div' : 'main'/)
assert.match(source, /Choose who gets a head start and how much/)
assert.doesNotMatch(source, /Import human CSV or JSON/)

// Copying starting accounts is still a creation input. Existing weighted-network selection is
// gone: Settings supplies one fixed instance id and loads its history directly.
assert.match(source, /<select\s+id="binary-instance"/)
assert.match(source, /useNetworks/)
assert.doesNotMatch(source, /fetchWeightedInstances/)
assert.doesNotMatch(source, /id="weighted-instance"/)
assert.match(source, /paste an instance ID instead/)
assert.match(source, /Settings →\s+Advanced →\s+Instance provenance/)
assert.match(source, /CopyableText/)

// A created network links to its detail and Settings surfaces. Legacy create?instance links are
// redirected rather than reopening administration inside the create wizard.
assert.match(source, /Your weighted network is created/)
assert.match(source, /href=\{`\/networks\/\$\{created\.instanceId\}`\}/)
assert.match(source, /View network/)
assert.match(source, /Review starting shares/)
assert.match(source, /openForUpdate/)
assert.match(source, /params\.get\('instance'\)/)
assert.match(source, /settings\?tab=scoring/)
assert.match(source, /params\.get\('accounts'\)/)

const settings = readFileSync(
  join(process.cwd(), 'app/networks/[id]/settings/component.tsx'),
  'utf8'
)
assert.match(
  settings,
  /<WeightedPriorWorkspace rotationInstanceId=\{instanceId as Hex\}/
)
const createPage = readFileSync(
  join(process.cwd(), 'app/create/weighted/page.tsx'),
  'utf8'
)
assert.match(
  createPage,
  /redirect\(`\/networks\/\$\{legacyInstance\}\/settings\?tab=scoring`\)/
)

// ENS handling is stated in plain words (clarification 3): resolved in the browser at a
// finalized mainnet block, receipt-only, re-checked before simulate and before sign.
assert.match(source, /resolved in your browser at a finalized/)
assert.match(source, /re-checked before you\s+simulate and before you sign/)

assert.match(source, /<label htmlFor="prior-format"/)
assert.match(source, /<label htmlFor="prior-file"/)
assert.match(source, /<label htmlFor="prior-source"/)
assert.match(source, /aria-invalid=\{fieldIssues\.length > 0\}/)
assert.match(source, /role="alert"/)
assert.match(source, /aria-live="polite"/)
assert.match(source, /aria-live="assertive"/)
assert.match(source, /MAX_WEIGHTED_IMPORT_BYTES/)
assert.match(source, /Cancel\s+preview/)
assert.match(source, /Rebuild\s+exact\s+preview/)
assert.match(source, /Copy\s+provenance/)
assert.match(source, /weightedExportArtifacts\(artifacts\)/)
assert.match(source, /artifacts\.priorRoot/)
assert.match(source, /artifacts\.manifestSha256/)
assert.match(source, /artifacts\.metadataDigest/)
assert.match(source, /transactionPayload/)
assert.match(source, /gasEstimate/)
assert.match(source, /gas: ETHEREUM_TRANSACTION_GAS_CAP/)
assert.match(
  source,
  /gas: bufferedEthereumGasLimit\(\s*gasEstimate \?\? ETHEREUM_TRANSACTION_GAS_CAP\s*\)/
)
assert.match(source, /recheckWeightedSource/)
assert.match(source, /WeightedEnsResolutionChangedError/)
for (const setter of [
  'setSourceUri',
  'setAuthor',
  'setLicense',
  'setTransform',
]) {
  assert.match(
    source,
    new RegExp(`${setter}\\(e\\.target\\.value\\)\\s+clearDerived\\(\\)`)
  )
}

// TGWP is a file format, not a user concept: it may appear in the verify/export section but
// never ahead of the source section (clarification 3 keeps wire formats out of the lede).
const firstTgwp = source.indexOf('TGWP')
const sourceHeading = source.indexOf('id="source-heading"')
assert.ok(firstTgwp > sourceHeading && sourceHeading > 0)

// Governance and the shared fund are explicit creation-time choices with
// plain-words copy and the voting profile is still validated against the wrapper factory.
assert.match(source, /Create with governance/)
assert.match(source, /A Safe is a shared onchain account/)
assert.match(source, /useAuthorityProfile/)
assert.doesNotMatch(
  source,
  /Member voting, read live from the governed factory/
)
assert.doesNotMatch(
  source,
  /Recovery: your wallet may publish one exact Safe action/
)
assert.doesNotMatch(source, /Updates to the starting shares take longer/)
assert.doesNotMatch(source, /Score-selected Safe signers are not offered/)
assert.match(source, /Add a shared fund/)
assert.match(source, /withDistributor: withFund/)
assert.match(source, /setWithGovernance\(true\)/)
assert.match(source, /Governance is required while a shared fund is selected/)
assert.match(source, /InvalidDistributorSafe/)
assert.match(source, /saveGovernancePrefill/)
assert.match(source, /Prepare governance proposal/)
assert.match(source, /Vouches and ordinary score updates do not require/)
assert.match(source, /Pay for score refreshes up front\?/)
assert.match(source, /DISABLED_SIGNER_SYNC/)

// Weighted creation offers the same plain-language scoring cadence as standard creation, starts
// at the factory floor, and submits the derived block count rather than asking for a raw number.
assert.match(source, /useState<Cadence>\('fastest'\)/)
assert.match(source, /How often scores can be recalculated/)
assert.match(source, /CADENCE_OPTIONS\.map/)
assert.match(source, /epochLength: requestedEpoch/)
assert.doesNotMatch(source, /Scoring round length \(blocks\)/)
assert.ok(
  source.indexOf('How often scores can be recalculated') <
    source.indexOf('id="source-heading"'),
  'weighted cadence must be visible before the starting-share import is built'
)
assert.match(
  source,
  /Starting weights replace the standard network&apos;s advanced/
)

// Weighted creation exposes the standard public network profile, pins it only when populated,
// and puts that exact metadata URI into the simulated create payload.
assert.match(source, /<NetworkProfileFields/)
assert.match(source, /hasNetworkProfile\(profile\)/)
assert.match(source, /await pinMetadata\(metadata\)/)
assert.match(source, /metadataURI: await ensureMetadataURI\(\)/)

// Receipt scanning is topic-keyed (parseEventLogs), never filtered by emitting address: under
// the governed wrapper the base factory emits the creation event and the Safe is the creator.
assert.match(source, /parseEventLogs/)
assert.doesNotMatch(
  source,
  /log\.address\.toLowerCase\(\)\s*[!=]==\s*WEIGHTED_FACTORY_ADDRESS/
)

console.log(
  'weighted workspace accessibility, pickers, copyable ids, recovery, and provenance controls: ok'
)
