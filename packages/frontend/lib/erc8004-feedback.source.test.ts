import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const explorer = readFileSync(
  join(process.cwd(), 'components/RawErc8004Feedback.tsx'),
  'utf8'
)
const page = readFileSync(
  join(
    process.cwd(),
    'app/agents/[namespace]/[chainId]/[registry]/[agentId]/page.tsx'
  ),
  'utf8'
)

assert.match(explorer, /Raw ERC-8004 feedback/)
assert.match(explorer, /unaggregated on-chain signals/)
assert.match(explorer, /nothing here is a global score/)
assert.match(explorer, /truth\s+claim/)
assert.match(explorer, /proof quality/)
assert.match(explorer, /Revoked · history retained/)
assert.match(explorer, /response neither validates\s+nor erases/)
assert.match(explorer, /Historically attributed/)
assert.match(explorer, /Ambiguous:/)
assert.match(explorer, /Unattributed:/)
assert.match(explorer, /On-chain pointers/)
assert.match(explorer, /External descriptor/)
assert.match(page, /Promise\.all\(\[/)
assert.match(page, /\/erc8004\/feedback\?/)

console.log('raw ERC-8004 feedback semantics and bulk UI wiring: ok')
