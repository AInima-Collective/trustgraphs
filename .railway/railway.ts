import {
  createRailwayContext,
  defineRailway,
  github,
  group,
  postgres,
  project,
  service,
  volume,
} from 'railway/iac'

const repository = () =>
  github('AInima-Collective/trustgraphs', { branch: 'main' })

// Keep stateful services together. Change this once, before the first apply, if the Railway
// workspace has a different preferred region; moving an attached volume later is destructive.
const region = 'us-west2'
const indexerDockerfile = 'packages/indexer/Dockerfile'
const operatorDockerfile = '.railway/operator.Dockerfile'

// Railway bills actual usage rather than a reserved machine size. These are its current minimum
// per-replica ceilings; start here for testnet and raise only the service that proves it needs more.
const minimumCompute = {
  containers: {
    cpu: 0.5,
    memoryBytes: 512 * 1024 * 1024,
  },
}

// The indexer is the one service that has outgrown that minimum. Its start path chains three Node
// processes - this launcher, pnpm, and Ponder itself - beside esbuild's native child while Ponder
// bundles the config, every indexing function, and the API. Node also sizes its heap from the
// host's RAM rather than from the container limit, so at 512 MB it grows past the ceiling and is
// killed before it writes its first line.
const indexerCompute = {
  containers: {
    cpu: 0.5,
    memoryBytes: 1024 * 1024 * 1024,
  },
}

// GitHub sources autodeploy by default. Restrict each service to files that can change its image
// so an unrelated monorepo commit does not spend Railway build credits twice.
const indexerWatchPaths = [
  '/.dockerignore',
  '/packages/indexer/**',
  '/packages/eas-offchain-client/**',
  '/packages/frontend/lib/**',
  '/contracts/deploy/**',
  '/config/**',
  '/deployments/**',
  '/scripts/load-env.cjs',
  '/scripts/redact-secrets.cjs',
  '/package.json',
  '/pnpm-lock.yaml',
  '/pnpm-workspace.yaml',
]
const operatorWatchPaths = [
  '/.railway/operator.Dockerfile',
  '/deployments/operator.sepolia.toml',
  '/deployments/sepolia.json',
]

export default defineRailway((input) => {
  // Railway CLI currently evaluates TypeScript IaC callbacks with a plain input object. Normalize
  // it through the SDK before using helpers such as ctx.shared and ctx.isEnvironment.
  const ctx = createRailwayContext(input)

  const database = postgres('Postgres', { region })
  const operatorState = volume('operator-state', {
    region,
    sizeMB: 512,
  })

  // The testnet database is deliberately rebuildable from Sepolia plus the configured IPFS
  // gateway. It remains Postgres because the Ponder app and its custom API use pg and Postgres
  // schemas directly; SQLite is not a runtime switch in this repository.
  const indexer = service('indexer', {
    source: repository(),
    build: { watchPatterns: indexerWatchPaths },
    deploy: { limitOverride: indexerCompute },
    start: 'node /app/packages/indexer/scripts/launch-indexer.mjs start',
    // Ponder's /ready stays 503 until historical indexing finishes. Railway only needs to know
    // the HTTP process is live before activating the deployment; the stable views schema remains
    // available while a fresh writer backfills.
    healthcheck: '/health',
    healthcheckTimeout: 600,
    replicas: { [region]: 1 },
    env: {
      RAILWAY_DOCKERFILE_PATH: indexerDockerfile,
      PORT: '65421',
      NODE_ENV: 'production',
      // Keep V8's own ceiling under the container limit so heap exhaustion raises a JavaScript
      // error the logs can carry, rather than a silent kernel kill that loses buffered stdout.
      NODE_OPTIONS: '--max-old-space-size=768',
      DEPLOY_STAGE: 'production',
      DEPLOY_TARGET: 'sepolia',
      DATABASE_URL: database.env.DATABASE_URL,
      PONDER_DATABASE_SCHEMA: 'trustgraph_sepolia_v2',
      PONDER_VIEWS_SCHEMA: 'trust-graph',
      PONDER_PORT: '65421',
      PONDER_RPC_URL_11155111: ctx.shared.RPC_URL_11155111_0,
      PONDER_RPC_URLS_11155111: ctx.shared.RPC_URL_11155111_1,
      PONDER_ETH_GET_LOGS_BLOCK_RANGE_11155111: '10',
      IPFS_GATEWAY: ctx.shared.IPFS_GATEWAY,
      EAS_OFFCHAIN_GATEWAYS: ctx.shared.IPFS_GATEWAY,
      FRONTEND_URL: 'https://trustgraphs.xyz',
    },
  })

  const operator = service('operator', {
    source: repository(),
    build: { watchPatterns: operatorWatchPaths },
    deploy: { limitOverride: minimumCompute },
    // Gate deployment on a bound, responsive daemon rather than a completed tick. A first tick can
    // include a paid network proof, so deployment activation must not time out and repeat it.
    healthcheck: '/health',
    healthcheckTimeout: 300,
    volumeMounts: {
      '/data': operatorState,
    },
    env: {
      RAILWAY_DOCKERFILE_PATH: operatorDockerfile,
      // Railway volumes are mounted root-owned. Railway documents this override for images whose
      // declared non-root UID otherwise cannot write their attached volume.
      RAILWAY_RUN_UID: '0',
      PORT: '8080',
      RPC_URL: ctx.shared.RPC_URL_11155111_0,
      SUBMITTER_PRIVATE_KEY: ctx.shared.SUBMITTER_PRIVATE_KEY,
      NETWORK_PRIVATE_KEY: ctx.shared.NETWORK_PRIVATE_KEY,
      IPFS_PIN_API: 'https://uploads.pinata.cloud/v3/files',
      IPFS_PIN_API_KEY: ctx.shared.IPFS_PIN_API_KEY,
      IPFS_GATEWAY: ctx.shared.IPFS_GATEWAY,
    },
  })

  const dataPlane = group('Data plane', [database, indexer])
  const proving = group('Proof service', [operatorState, operator])

  return project('trustgraphs-sepolia', {
    resources: [dataPlane, proving],
  })
})
