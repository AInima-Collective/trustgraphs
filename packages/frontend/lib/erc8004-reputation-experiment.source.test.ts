import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const component = readFileSync(
  join(process.cwd(), 'components/Erc8004ReputationExperiment.tsx'),
  'utf8'
)
const route = readFileSync(
  join(process.cwd(), 'app/experiments/erc8004-reputation/page.tsx'),
  'utf8'
)
const rawExplorer = readFileSync(
  join(process.cwd(), 'components/RawErc8004Feedback.tsx'),
  'utf8'
)
const presentation = JSON.parse(
  readFileSync(
    join(process.cwd(), 'lib/erc8004-reputation-experiment.json'),
    'utf8'
  )
)
const golden = JSON.parse(
  readFileSync(
    join(process.cwd(), '../../research/erc8004-reputation/golden.json'),
    'utf8'
  )
)

assert.deepEqual(presentation.generatedFrom, {
  policySha256: golden.policySha256,
  inputSha256: golden.inputSha256,
  resultSha256: golden.resultSha256,
})
assert.equal(
  presentation.recommendation.decision,
  'no-go-for-production-or-proof'
)
assert.equal(presentation.metrics.coverage.missingPairs, 19)
assert.equal(presentation.metrics.coverage.observedZeroPairs, 1)

assert.match(component, /experimental, unproved, policy-specific/)
assert.match(component, /separate from\s+proven TrustGraph scores/)
assert.match(component, /not a universal agent reputation/)
assert.match(
  component,
  /Current wallet and owner\s+state are never substituted/
)
assert.match(component, /Missing pairs/)
assert.match(component, /Not zero or negative/)
assert.match(component, /Positive-edge experiment graph/)
assert.match(component, /<table/)
assert.match(
  component,
  /Responses remain observations and do not validate or erase feedback/
)
assert.match(
  component,
  /No value on this page changes a\s+score, vouch edge, root, proof/
)
assert.match(route, /Erc8004ReputationExperiment/)
assert.match(rawExplorer, /\/experiments\/erc8004-reputation/)

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(ts|tsx|rs|sol)$/.test(name)
        ? [path]
        : []
  })

for (const directory of [
  join(process.cwd(), 'lib/pagerank'),
  join(process.cwd(), 'lib/hypercerts'),
  join(process.cwd(), 'lib/contributions'),
  join(process.cwd(), 'lib/weighted-prior'),
  join(process.cwd(), '../../crates/pagerank-core/src'),
  join(process.cwd(), '../../crates/hypercerts-core/src'),
  join(process.cwd(), '../../crates/contributions-core/src'),
  join(process.cwd(), '../../crates/weighted-prior-core/src'),
  join(process.cwd(), '../indexer/src'),
  join(process.cwd(), '../../zk/program/src'),
  join(process.cwd(), '../../zk/weighted-program/src'),
  join(process.cwd(), '../../zk/prover/src'),
]) {
  for (const path of sourceFiles(directory)) {
    assert.doesNotMatch(
      readFileSync(path, 'utf8'),
      /erc8004-reputation-experiment/,
      `${path} must not import the experimental artifact`
    )
  }
}

console.log(
  'ERC-8004 experiment labels, artifact sync, and score isolation: ok'
)
