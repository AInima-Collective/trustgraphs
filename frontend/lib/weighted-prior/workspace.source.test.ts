import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(
  join(process.cwd(), 'app/create/weighted/workspace.tsx'),
  'utf8'
)

// This structural contract keeps the critical accessible recovery controls attached to the real
// client component without introducing a second, test-only rendering of the workflow.
assert.match(source, /<main[^>]+aria-labelledby="weighted-title"/)
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

console.log(
  'weighted workspace accessibility, limits, recovery, and provenance controls: ok'
)
