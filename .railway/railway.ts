import {
  defineRailway,
  github,
  group,
  postgres,
  project,
  service,
  volume,
} from 'railway/iac'

const repository = () =>
  github('AInima-Collective/trustgraphs', { branch: 'sepolia' })

// Keep stateful services together. Change this once, before the first apply, if the Railway
// workspace has a different preferred region; moving an attached volume later is destructive.
const region = 'us-west2'
const indexerDockerfile = 'packages/indexer/Dockerfile'
const operatorDockerfile = '.railway/operator.Dockerfile'

export default defineRailway((ctx) => {
  const database = postgres('Postgres')
  const operatorState = volume('operator-state', {
    region,
    sizeMB: 512,
  })

  // The testnet database is deliberately rebuildable from Sepolia plus the configured IPFS
  // gateway. It remains Postgres because the Ponder app and its custom API use pg and Postgres
  // schemas directly; SQLite is not a runtime switch in this repository.
  const indexer = service('indexer', {
    source: repository(),
    start: 'node /app/packages/indexer/scripts/launch-indexer.mjs start',
    healthcheck: '/ready',
    healthcheckTimeout: 600,
    replicas: { [region]: 1 },
    env: {
      RAILWAY_DOCKERFILE_PATH: indexerDockerfile,
      PORT: '65421',
      NODE_ENV: 'production',
      DEPLOY_STAGE: 'production',
      DEPLOY_TARGET: 'sepolia',
      DATABASE_URL: database.env.DATABASE_URL,
      PONDER_DATABASE_SCHEMA: 'trustgraph_sepolia_v2',
      PONDER_VIEWS_SCHEMA: 'trust-graph',
      PONDER_PORT: '65421',
      PONDER_HEALTH_PORT: '65421',
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
    // Gate deployment on a bound, responsive daemon rather than a completed tick. A first tick can
    // include a paid network proof; the monitor below checks /ready continuously without making
    // Railway kill and repeat in-flight work when deployment activation reaches its timeout.
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
      OPERATOR_ALERT_WEBHOOK: ctx.shared.OPERATOR_ALERT_WEBHOOK,
    },
  })

  const monitor = service('monitor', {
    source: repository(),
    start: 'node /app/ops/monitor-production.mjs',
    replicas: { [region]: 1 },
    env: {
      RAILWAY_DOCKERFILE_PATH: indexerDockerfile,
      MONITOR_INDEXER_URL: `http://${indexer.env.RAILWAY_PRIVATE_DOMAIN}:65421`,
      MONITOR_OPERATOR_URL: `http://${operator.env.RAILWAY_PRIVATE_DOMAIN}:8080`,
      MONITOR_RPC_URL: ctx.shared.RPC_URL_11155111_0,
      MONITOR_ALERT_WEBHOOK: ctx.shared.OPERATOR_ALERT_WEBHOOK,
      MONITOR_INTERVAL_SECONDS: '60',
      MONITOR_INDEXER_MAX_LAG_BLOCKS: '20',
      MONITOR_OPERATOR_MAX_STALE_SECONDS: '300',
      MONITOR_STALE_ROOT_BLOCKS: '7200',
      MONITOR_MIN_VAULT_ETH_WEI: '0',
      MONITOR_MIN_VAULT_USDC: '0',
      MONITOR_REQUIRE_ROOT: 'true',
    },
  })

  const dataPlane = group('Data plane', [database, indexer, monitor])
  const proving = group('Proof service', [operatorState, operator])

  return project('trustgraphs-sepolia', {
    resources: [dataPlane, proving],
  })
})
