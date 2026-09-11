import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = (relative) =>
  fs.readFileSync(path.join(repository, relative), 'utf8')
const readJson = (relative) => JSON.parse(read(relative))
const exists = (relative) => fs.existsSync(path.join(repository, relative))

// The authoring files are TypeScript that the Railway CLI evaluates with Node's own type
// stripping. Importing them here the same way lets this preflight assert the graph each project
// would actually receive, not what a regex finds in the source.
const importAuthoring = async (relative) => {
  try {
    return await import(pathToFileURL(path.join(repository, relative)).href)
  } catch (error) {
    if (error?.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
      throw new Error(
        `${relative} needs a Node release that strips TypeScript types (22.18 or newer); this is ${process.version}`,
        { cause: error }
      )
    }
    throw error
  }
}

const packageManifest = readJson('package.json')
assert.equal(
  packageManifest.devDependencies?.railway,
  '3.11.0',
  'the Railway IaC authoring SDK must be installed and pinned locally'
)

const { createRailwayContext } = await import('railway/iac')
const { TARGETS } = await importAuthoring('.railway/targets.ts')
const { indexerRpcPool, trustgraphsProject } = await importAuthoring(
  '.railway/lib/project.ts'
)
const { default: railway } = await importAuthoring('.railway/railway.ts')

const dockerignore = read('.dockerignore')
const indexerDockerfile = read('packages/indexer/Dockerfile')
const operatorDockerfile = read('.railway/operator.Dockerfile')
const sepoliaProfile = read('deployments/operator.sepolia.toml')
const sepoliaManifest = readJson('deployments/sepolia.json')
const mainnetManifest = readJson('deployments/mainnet.json')

const operatorImage =
  'ghcr.io/ainima-collective/trustgraphs-operator@sha256:645944e4ed08277bdbd1a9efc8e841af621565b02f82acaf251e39fdea301092'

// --- The targets table -------------------------------------------------------------------------

assert.deepEqual(
  Object.keys(TARGETS).sort(),
  ['trustgraphs-mainnet', 'trustgraphs-sepolia'],
  'exactly the two Trustgraphs projects, by their dashboard names'
)
const sepoliaRow = TARGETS['trustgraphs-sepolia']
const mainnetRow = TARGETS['trustgraphs-mainnet']

// Every Sepolia value is what `railway config plan` must find already applied to the live project.
assert.deepEqual(
  { ...sepoliaRow, startBlocks: sepoliaRow.startBlocks() },
  {
    projectName: 'trustgraphs-sepolia',
    deployTarget: 'sepolia',
    chainId: 11155111,
    branch: 'main',
    region: {
      database: 'us-west2',
      operatorState: 'us-east4-eqdc4a',
      indexer: 'us-east4-eqdc4a',
    },
    writerSchema: 'trustgraph_sepolia_v7',
    // PONDER_START_BLOCK_11155111 is not set on the live service; adding it would turn the
    // no-op plan into a change.
    startBlocks: { easStartBlock: '11670854' },
    rpcFallbacks: [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://sepolia.gateway.tenderly.co',
    ],
    operatorRpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    frontendUrl: 'https://trustgraphs.xyz',
    shared: {
      rpcPrimary: 'RPC_URL_11155111_0',
      ipfsGateway: 'IPFS_GATEWAY',
      ipfsPinApiKey: 'IPFS_PIN_API_KEY',
      submitterPrivateKey: 'SUBMITTER_PRIVATE_KEY',
      networkPrivateKey: 'NETWORK_PRIVATE_KEY',
    },
    operatorEnv: {},
    indexerMemoryBytes: 1024 * 1024 * 1024,
    operatorMemoryBytes: 2_000_000_000,
  },
  'the Sepolia row must reproduce the live topology exactly'
)

const { startBlocks: mainnetStartBlocks, ...mainnetStatic } = mainnetRow
assert.deepEqual(
  mainnetStatic,
  {
    projectName: 'trustgraphs-mainnet',
    deployTarget: 'mainnet',
    chainId: 1,
    branch: 'mainnet',
    region: {
      database: 'us-west2',
      operatorState: 'us-west2',
      indexer: 'us-west2',
    },
    writerSchema: 'trustgraph_mainnet_v1',
    rpcFallbacks: [
      'https://ethereum-rpc.publicnode.com',
      'https://mainnet.gateway.tenderly.co',
    ],
    operatorRpcUrl: 'https://ethereum-rpc.publicnode.com',
    frontendUrl: 'https://trustgraphs.xyz',
    shared: {
      rpcPrimary: 'RPC_URL_1_0',
      ipfsGateway: 'IPFS_GATEWAY',
      ipfsPinApiKey: 'IPFS_PIN_API_KEY',
      submitterPrivateKey: 'SUBMITTER_PRIVATE_KEY',
      networkPrivateKey: 'NETWORK_PRIVATE_KEY',
      operatorAlertWebhook: 'OPERATOR_ALERT_WEBHOOK',
    },
    operatorEnv: { DEPLOY_TARGET: 'mainnet' },
    indexerMemoryBytes: 1024 * 1024 * 1024,
    operatorMemoryBytes: 2_000_000_000,
  },
  'the mainnet row must match the reviewed plan'
)

const mainnetDeployed = mainnetManifest.firstDeploymentBlock != null
if (mainnetDeployed) {
  const block = String(mainnetManifest.firstDeploymentBlock)
  assert.deepEqual(
    mainnetStartBlocks(),
    { easStartBlock: block, startBlock: block },
    'both mainnet cursors must start at the generation first block from deployments/mainnet.json'
  )
} else {
  assert.throws(
    () => mainnetStartBlocks(),
    /firstDeploymentBlock/,
    'planning the mainnet project before the contracts are deployed must fail with a clear error'
  )
}

for (const row of [sepoliaRow, mainnetRow]) {
  const label = row.projectName
  assert.equal(
    row.shared.rpcPrimary,
    `RPC_URL_${row.chainId}_0`,
    `${label}: chain-suffixed primary`
  )
  // The indexer RPC list is pinned alchemy-first (as a resolved shared template) with independent
  // public fallbacks; a pool without a host independent of the metered primary is exactly the
  // regression the launcher fails closed on.
  const pool = indexerRpcPool(row).split(',')
  assert.equal(
    pool[0],
    '${{shared.' + row.shared.rpcPrimary + '}}',
    `${label}: the metered primary must lead the indexer RPC list`
  )
  assert.deepEqual(pool.slice(1), [...row.rpcFallbacks])
  assert.ok(
    row.rpcFallbacks.length >= 2,
    `${label}: at least two independent public fallbacks`
  )
  const hosts = row.rpcFallbacks.map((url) => new URL(url).host)
  assert.equal(
    new Set(hosts).size,
    hosts.length,
    `${label}: fallbacks must be distinct hosts`
  )
  for (const url of row.rpcFallbacks) {
    assert.equal(
      new URL(url).protocol,
      'https:',
      `${label}: ${url} must be HTTPS`
    )
    assert.doesNotMatch(
      new URL(url).host,
      /alchemy/,
      `${label}: a fallback cannot share the primary's host`
    )
  }
  assert.equal(new URL(row.operatorRpcUrl).protocol, 'https:')
  if (row.deployTarget === 'sepolia') {
    assert.equal(
      row.operatorEnv.DEPLOY_TARGET,
      undefined,
      'the Dockerfile default already selects the Sepolia profile; a variable here would change the live plan'
    )
  } else {
    assert.equal(
      row.operatorEnv.DEPLOY_TARGET,
      row.deployTarget,
      `${label}: a non-default target must select its own operator profile through the Dockerfile build arg`
    )
  }
}

// --- The graph each project receives --------------------------------------------------------------

const context = (projectName) =>
  createRailwayContext({
    command: 'plan',
    projectName,
    environment: 'production',
    environmentName: 'production',
  })
const plan = (projectName) => railway(context(projectName))

assert.throws(
  () => plan('trustgraphs-goerli'),
  /No Trustgraphs target for Railway project "trustgraphs-goerli"\. Known projects: .*trustgraphs-sepolia.*trustgraphs-mainnet/,
  'an unknown project must fail listing the known ones'
)
assert.throws(
  () => plan(undefined),
  /name not reported/,
  'a missing project name must fail, not default'
)

const literal = (value) => ({ type: 'literal', value })
const shared = (name) => ({ type: 'sharedReference', name })
const variables = (entries) =>
  Object.fromEntries(
    Object.entries(entries).map(([key, value]) => [
      key,
      typeof value === 'string' ? literal(value) : value,
    ])
  )
const resource = (definition, type, name) => {
  const node = definition.resources.find(
    (r) => r.type === type && r.name === name
  )
  assert.ok(node, `${definition.name}: ${type} ${name} is missing`)
  return node
}

const checkTopology = (definition, row, blocks) => {
  const label = row.projectName
  assert.equal(definition.name, row.projectName)
  const services = definition.resources.filter((r) => r.type === 'service')
  assert.deepEqual(
    services.map((s) => s.name).sort(),
    ['indexer', 'operator'],
    `${label}: exactly the two application services; the log-only monitor must not consume an always-on Railway service`
  )

  const database = resource(definition, 'database', 'Postgres')
  assert.equal(database.engine, 'postgres')
  assert.deepEqual(database.deploy.multiRegionConfig, {
    [row.region.database]: { numReplicas: 1 },
  })
  const operatorState = resource(definition, 'volume', 'operator-state')
  assert.deepEqual(operatorState.config, {
    region: row.region.operatorState,
    sizeMB: 512,
  })

  const indexer = resource(definition, 'service', 'indexer')
  const operator = resource(definition, 'service', 'operator')
  for (const service of [indexer, operator]) {
    assert.deepEqual(service.source, {
      type: 'github',
      repo: 'AInima-Collective/trustgraphs',
      branch: row.branch,
    })
    assert.equal(
      service.deploy.healthcheckPath,
      '/health',
      `${label}: both Railway services must use liveness health checks`
    )
    assert.equal(
      service.deploy.limitOverride.containers.cpu,
      0.5,
      `${label}: every application service must declare a reviewed compute ceiling`
    )
  }
  assert.equal(indexer.groupId, 'Data plane')
  assert.equal(operator.groupId, 'Proof service')
  assert.equal(indexer.deploy.healthcheckTimeout, 600)
  assert.equal(operator.deploy.healthcheckTimeout, 300)
  assert.equal(
    indexer.deploy.limitOverride.containers.memoryBytes,
    1024 * 1024 * 1024,
    "the indexer's ceiling must be the reviewed 1 GB; Ponder's start path runs three Node processes and was killed at 512 MB before it could log"
  )
  assert.equal(
    operator.deploy.limitOverride.containers.memoryBytes,
    2_000_000_000,
    'the operator must use its reviewed 2 GB ceiling; SP1 vkey setup OOM-loops at the platform minimum before the health listener binds'
  )
  assert.deepEqual(indexer.deploy.multiRegionConfig, {
    [row.region.indexer]: { numReplicas: 1 },
  })
  assert.equal(
    indexer.deploy.startCommand,
    'node /app/packages/indexer/scripts/launch-indexer.mjs start'
  )
  assert.ok(indexer.build.watchPatterns.includes('/.dockerignore'))
  assert.deepEqual(operator.build.watchPatterns, [
    '/.railway/operator.Dockerfile',
    `/deployments/operator.${row.deployTarget}.toml`,
    `/deployments/${row.deployTarget}.json`,
  ])
  assert.equal(indexer.volumeAttachments, undefined, 'the indexer is stateless')
  assert.equal(
    operator.volumeAttachments['operator-state'].volume,
    'volume.operator-state'
  )
  assert.equal(operator.volumeAttachments['operator-state'].mountPath, '/data')

  const id = row.chainId
  assert.deepEqual(
    indexer.variables,
    variables({
      RAILWAY_DOCKERFILE_PATH: 'packages/indexer/Dockerfile',
      PORT: '65421',
      NODE_ENV: 'production',
      // Cap V8 below the container limit so heap exhaustion is logged, not silently killed.
      NODE_OPTIONS: '--max-old-space-size=768',
      DEPLOY_STAGE: 'production',
      DEPLOY_TARGET: row.deployTarget,
      DATABASE_URL: {
        type: 'reference',
        resource: 'database.Postgres',
        output: 'DATABASE_URL',
      },
      PONDER_DATABASE_SCHEMA: row.writerSchema,
      [`PONDER_EAS_START_BLOCK_${id}`]: blocks.easStartBlock,
      ...(blocks.startBlock === undefined
        ? {}
        : { [`PONDER_START_BLOCK_${id}`]: blocks.startBlock }),
      PONDER_VIEWS_SCHEMA: 'trust-graph',
      PONDER_PORT: '65421',
      [`PONDER_RPC_URL_${id}`]: shared(row.shared.rpcPrimary),
      [`PONDER_RPC_URLS_${id}`]: indexerRpcPool(row),
      [`PONDER_ETH_GET_LOGS_BLOCK_RANGE_${id}`]: '10',
      IPFS_GATEWAY: shared('IPFS_GATEWAY'),
      EAS_OFFCHAIN_GATEWAYS: shared('IPFS_GATEWAY'),
      FRONTEND_URL: row.frontendUrl,
    }),
    `${label}: the indexer variable set must be exactly the reviewed one`
  )
  assert.deepEqual(
    operator.variables,
    variables({
      RAILWAY_DOCKERFILE_PATH: '.railway/operator.Dockerfile',
      // Railway mounts volumes root-owned; this documented override is scoped to the operator.
      RAILWAY_RUN_UID: '0',
      PORT: '8080',
      RPC_URL: row.operatorRpcUrl,
      SUBMITTER_PRIVATE_KEY: shared('SUBMITTER_PRIVATE_KEY'),
      NETWORK_PRIVATE_KEY: shared('NETWORK_PRIVATE_KEY'),
      IPFS_PIN_API: 'https://uploads.pinata.cloud/v3/files',
      IPFS_PIN_API_KEY: shared('IPFS_PIN_API_KEY'),
      IPFS_GATEWAY: shared('IPFS_GATEWAY'),
      ...row.operatorEnv,
      ...(row.shared.operatorAlertWebhook === undefined
        ? {}
        : { OPERATOR_ALERT_WEBHOOK: shared(row.shared.operatorAlertWebhook) }),
    }),
    `${label}: the operator variable set must be exactly the reviewed one`
  )
  return { indexer, operator }
}

const sepolia = plan('trustgraphs-sepolia')
assert.throws(
  () => plan('reasonable-purpose'),
  /No Trustgraphs target for Railway project/,
  'the pre-rename project name is not a target any more'
)
const sepoliaServices = checkTopology(sepolia, sepoliaRow, {
  easStartBlock: '11670854',
})
assert.equal(
  sepoliaServices.indexer.variables.PONDER_RPC_URLS_11155111.value,
  '${{shared.RPC_URL_11155111_0}},https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.gateway.tenderly.co'
)
assert.equal(
  sepoliaServices.indexer.variables.PONDER_EAS_START_BLOCK_11155111.value,
  '11670854'
)
assert.equal(
  sepoliaServices.indexer.variables.PONDER_START_BLOCK_11155111,
  undefined
)
assert.equal(
  sepoliaServices.indexer.variables.PONDER_DATABASE_SCHEMA.value,
  'trustgraph_sepolia_v7'
)
assert.equal(sepoliaServices.operator.variables.DEPLOY_TARGET, undefined)
assert.equal(
  sepoliaServices.operator.variables.OPERATOR_ALERT_WEBHOOK,
  undefined
)

// The mainnet graph is checked with the real manifest once deployed, and with stand-in blocks
// before that so the builder's mainnet path is exercised either way.
const mainnetBlocks = mainnetDeployed
  ? mainnetStartBlocks()
  : { easStartBlock: '1', startBlock: '1' }
const mainnet = mainnetDeployed
  ? plan('trustgraphs-mainnet')
  : trustgraphsProject(context('trustgraphs-mainnet'), {
      ...mainnetRow,
      startBlocks: () => mainnetBlocks,
    })
if (!mainnetDeployed) {
  assert.throws(() => plan('trustgraphs-mainnet'), /firstDeploymentBlock/)
}
const mainnetServices = checkTopology(mainnet, mainnetRow, mainnetBlocks)
assert.equal(
  mainnetServices.indexer.variables.PONDER_START_BLOCK_1.value,
  mainnetBlocks.startBlock
)
assert.equal(mainnetServices.operator.variables.DEPLOY_TARGET.value, 'mainnet')
assert.deepEqual(
  mainnetServices.operator.variables.OPERATOR_ALERT_WEBHOOK,
  shared('OPERATOR_ALERT_WEBHOOK')
)

for (const file of [
  '.railway/railway.ts',
  '.railway/lib/project.ts',
  '.railway/targets.ts',
]) {
  assert.equal(
    read(file).includes("service('monitor'"),
    false,
    'the log-only monitor must not consume an always-on Railway service'
  )
}
assert.equal(
  read('.railway/railway.ts').includes("service('"),
  false,
  'railway.ts only switches on the linked project; the topology lives in lib/project.ts'
)

// --- Images, profiles and manifests -------------------------------------------------------------

assert.doesNotMatch(
  indexerDockerfile,
  /--mount=type=cache/,
  'Railway cache mounts require a service-ID prefix; use the dependency layer cache instead'
)
for (const pattern of [
  'packages/indexer/**/*.test.*',
  'packages/eas-offchain-client/**/*.test.*',
  'packages/frontend/lib/**/*.test.*',
  'contracts/deploy/**/*.test.*',
]) {
  assert.ok(
    dockerignore.split('\n').includes(pattern),
    `${pattern} must be excluded before Docker COPY so Railway never has to apply deletion whiteouts`
  )
}
assert.doesNotMatch(
  indexerDockerfile,
  /find packages\/indexer\/src -name '\*\.test\.ts' -exec/,
  'do not delete copied indexer tests in a later image layer; Railway Runtime V2 can expose whiteouted files'
)
assert.match(
  indexerDockerfile,
  /find packages\/indexer packages\/eas-offchain-client packages\/frontend\/lib contracts\/deploy/,
  'the image build must assert that the Docker context did not carry tests in any copied source tree'
)

assert.ok(
  operatorDockerfile.includes(`FROM ${operatorImage}`),
  'Railway operator layer must pin the reviewed image digest'
)
// The layer copies one profile and one manifest, selected either by the historical Sepolia
// literals or by the DEPLOY_TARGET build arg, which must default to sepolia so the live Sepolia
// service needs no new variable.
const profileSelector = '(sepolia|\\$\\{DEPLOY_TARGET\\})'
assert.match(
  operatorDockerfile,
  new RegExp(
    `COPY --chown=10001:10001 deployments\\/operator\\.${profileSelector}\\.toml \\/etc\\/trustgraph\\/operator\\.toml`
  )
)
assert.match(
  operatorDockerfile,
  new RegExp(
    `COPY --chown=10001:10001 deployments\\/${profileSelector}\\.json \\/etc\\/trustgraph\\/${profileSelector}\\.json`
  )
)
if (operatorDockerfile.includes('DEPLOY_TARGET')) {
  assert.match(
    operatorDockerfile,
    /^ARG DEPLOY_TARGET=sepolia$/m,
    'the operator build arg must default to sepolia so the Sepolia service plan stays a no-op'
  )
}

const checkOperatorProfile = (profile, manifestFile) => {
  assert.match(
    profile,
    new RegExp(`^release_manifest = "${manifestFile}"$`, 'm')
  )
  assert.match(profile, /^state_dir = "\/data"$/m)
  assert.match(profile, /^journal_path = "\/data\/journal\.jsonl"$/m)
  assert.match(profile, /^listen = "\[::\]:8080"$/m)
}
checkOperatorProfile(sepoliaProfile, 'sepolia\\.json')
assert.match(sepoliaProfile, /^min_success = 1$/m)
if (mainnetDeployed || exists('deployments/operator.mainnet.toml')) {
  checkOperatorProfile(
    read('deployments/operator.mainnet.toml'),
    'mainnet\\.json'
  )
}

assert.equal(sepoliaManifest.status, 'deployed')
assert.equal(sepoliaManifest.stage, 'production')
assert.equal(sepoliaManifest.chain, 'sepolia')
assert.equal(sepoliaManifest.chainId, 11155111)
assert.equal(sepoliaManifest.chainId, sepoliaRow.chainId)
assert.equal(
  String(sepoliaManifest.firstDeploymentBlock),
  sepoliaRow.startBlocks().easStartBlock,
  'the Sepolia EAS crawl is bounded to the generation first block recorded in the manifest'
)
assert.match(
  sepoliaManifest.contracts.instanceRegistry.address,
  /^0x[0-9a-fA-F]{40}$/
)
assert.match(
  sepoliaManifest.contracts.governedTrustgraphsFactory.address,
  /^0x[0-9a-fA-F]{40}$/
)

assert.equal(mainnetManifest.stage, 'production')
assert.equal(mainnetManifest.chain, 'mainnet')
assert.equal(mainnetManifest.chainId, 1)
assert.equal(mainnetManifest.chainId, mainnetRow.chainId)
assert.ok(
  ['planned', 'deployed'].includes(mainnetManifest.status),
  'deployments/mainnet.json is the seed manifest until it records a deployment'
)
if (mainnetManifest.status === 'deployed') {
  assert.ok(
    Number.isInteger(mainnetManifest.firstDeploymentBlock),
    'a deployed mainnet manifest must record its first block'
  )
}

for (const deprecated of ['railway.json', 'railway.toml']) {
  assert.equal(
    exists(deprecated),
    false,
    `${deprecated} is deprecated; keep the project in .railway/railway.ts`
  )
}

console.log('Railway configuration preflight passed')
