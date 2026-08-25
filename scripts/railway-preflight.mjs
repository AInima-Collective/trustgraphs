import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = (relative) =>
  fs.readFileSync(path.join(repository, relative), 'utf8')

const iac = read('.railway/railway.ts')
const indexerDockerfile = read('packages/indexer/Dockerfile')
const operatorDockerfile = read('.railway/operator.Dockerfile')
const operatorProfile = read('deployments/operator.sepolia.toml')
const manifest = JSON.parse(read('deployments/sepolia.json'))
const packageManifest = JSON.parse(read('package.json'))

const operatorImage =
  'ghcr.io/ainima-collective/trustgraphs-operator@sha256:876aa9e9569e2de4366404a96b24ae4222e75763cbc692820bd9cdbfd15e0a40'

assert.equal(
  packageManifest.devDependencies?.railway,
  '3.11.0',
  'the Railway IaC authoring SDK must be installed and pinned locally'
)

for (const required of [
  'createRailwayContext',
  'const ctx = createRailwayContext(input)',
  "project('trustgraphs-sepolia'",
  "github('AInima-Collective/trustgraphs', { branch: 'sepolia' })",
  "postgres('Postgres', { region })",
  "service('indexer'",
  "service('operator'",
  "healthcheck: '/health'",
  'cpu: 0.5',
  'memoryBytes: 512 * 1024 * 1024',
  "'/.railway/operator.Dockerfile'",
  "volume('operator-state'",
  "'/data': operatorState",
  "RAILWAY_RUN_UID: '0'",
  "FRONTEND_URL: 'https://trustgraphs.xyz'",
  'ctx.shared.RPC_URL_11155111_0',
  'ctx.shared.RPC_URL_11155111_1',
  'ctx.shared.IPFS_GATEWAY',
  'ctx.shared.IPFS_PIN_API_KEY',
  'ctx.shared.SUBMITTER_PRIVATE_KEY',
  'ctx.shared.NETWORK_PRIVATE_KEY',
]) {
  assert.ok(iac.includes(required), `Railway IaC is missing ${required}`)
}

assert.equal(
  (iac.match(/healthcheck: '\/health'/g) ?? []).length,
  2,
  'both Railway services must use liveness health checks'
)

assert.equal(
  iac.match(/deploy: \{ limitOverride: minimumCompute \}/g)?.length,
  2,
  'every application service must use the minimum testnet compute ceiling'
)
assert.equal(
  iac.includes("service('monitor'"),
  false,
  'the log-only monitor must not consume an always-on Railway service'
)
assert.doesNotMatch(
  indexerDockerfile,
  /--mount=type=cache/,
  'Railway cache mounts require a service-ID prefix; use the dependency layer cache instead'
)

assert.ok(
  operatorDockerfile.includes(`FROM ${operatorImage}`),
  'Railway operator layer must pin the reviewed image digest'
)
assert.match(
  operatorDockerfile,
  /COPY --chown=10001:10001 deployments\/operator\.sepolia\.toml \/etc\/trustgraph\/operator\.toml/
)
assert.match(
  operatorDockerfile,
  /COPY --chown=10001:10001 deployments\/sepolia\.json \/etc\/trustgraph\/sepolia\.json/
)

assert.match(operatorProfile, /^release_manifest = "sepolia\.json"$/m)
assert.match(operatorProfile, /^state_dir = "\/data"$/m)
assert.match(operatorProfile, /^journal_path = "\/data\/journal\.jsonl"$/m)
assert.match(operatorProfile, /^listen = "\[::\]:8080"$/m)
assert.match(operatorProfile, /^min_success = 1$/m)

assert.equal(manifest.status, 'deployed')
assert.equal(manifest.stage, 'production')
assert.equal(manifest.chain, 'sepolia')
assert.equal(manifest.chainId, 11155111)
assert.match(manifest.contracts.instanceRegistry.address, /^0x[0-9a-fA-F]{40}$/)
assert.match(
  manifest.contracts.governedTrustgraphsFactory.address,
  /^0x[0-9a-fA-F]{40}$/
)

for (const deprecated of ['railway.json', 'railway.toml']) {
  assert.equal(
    fs.existsSync(path.join(repository, deprecated)),
    false,
    `${deprecated} is deprecated; keep the project in .railway/railway.ts`
  )
}

console.log('Railway configuration preflight passed')
