import {
  github,
  group,
  postgres,
  project,
  service,
  volume,
  type ProjectDefinition,
  type RailwayContext,
} from 'railway/iac'
import type { RailwayTarget } from '../targets.ts'

const indexerDockerfile = 'packages/indexer/Dockerfile'
const operatorDockerfile = '.railway/operator.Dockerfile'

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
const operatorWatchPaths = (target: RailwayTarget) => [
  '/.railway/operator.Dockerfile',
  `/deployments/operator.${target.deployTarget}.toml`,
  `/deployments/${target.deployTarget}.json`,
]

// The complete ordered RPC list: the metered primary first (as a ${{shared.*}} template the
// platform resolves, keeping the paid URL out of this file), then the independent public
// fallbacks. ponder.config prepends the primary and dedupes, so repeating it here is harmless —
// but the list reading alchemy-first is what stopped the near-identical PONDER_RPC_URL /
// PONDER_RPC_URLS names from being "corrected" into a pool with no independent failover
// (2026-08-26, twice; the launcher now refuses to start that way).
export const indexerRpcPool = (target: RailwayTarget): string =>
  ['${{shared.' + target.shared.rpcPrimary + '}}', ...target.rpcFallbacks].join(
    ','
  )

// The same four resources for every chain: Postgres, the indexer, the operator and its state
// volume. Everything chain-specific comes from the target row.
export function trustgraphsProject(
  ctx: RailwayContext,
  target: RailwayTarget
): ProjectDefinition {
  const { chainId } = target
  const repository = github('AInima-Collective/trustgraphs', {
    branch: target.branch,
  })
  const blocks = target.startBlocks()

  const database = postgres('Postgres', { region: target.region.database })
  const operatorState = volume('operator-state', {
    region: target.region.operatorState,
    sizeMB: 512,
  })

  // The database is deliberately rebuildable from the chain plus the configured IPFS gateway. It
  // remains Postgres because the Ponder app and its custom API use pg and Postgres schemas
  // directly; SQLite is not a runtime switch in this repository.
  const indexer = service('indexer', {
    source: repository,
    build: { watchPatterns: indexerWatchPaths },
    deploy: {
      limitOverride: {
        containers: { cpu: 0.5, memoryBytes: target.indexerMemoryBytes },
      },
    },
    start: 'node /app/packages/indexer/scripts/launch-indexer.mjs start',
    // Ponder's /ready stays 503 until historical indexing finishes. Railway only needs to know
    // the HTTP process is live before activating the deployment; the stable views schema remains
    // available while a fresh writer backfills.
    healthcheck: '/health',
    healthcheckTimeout: 600,
    replicas: { [target.region.indexer]: 1 },
    env: {
      RAILWAY_DOCKERFILE_PATH: indexerDockerfile,
      PORT: '65421',
      NODE_ENV: 'production',
      // Keep V8's own ceiling under the container limit so heap exhaustion raises a JavaScript
      // error the logs can carry, rather than a silent kernel kill that loses buffered stdout.
      NODE_OPTIONS: '--max-old-space-size=768',
      DEPLOY_STAGE: 'production',
      DEPLOY_TARGET: target.deployTarget,
      DATABASE_URL: database.env.DATABASE_URL,
      PONDER_DATABASE_SCHEMA: target.writerSchema,
      // The canonical EAS contract and Schema Registry otherwise index from the chain's genesis:
      // on Sepolia ~11.7M blocks in 10-block eth_getLogs windows per source, a crawl that
      // exhausted the metered primary's monthly quota on 2026-09-10 and repeats on every
      // writer-schema bump. Bounding it to the generation's first block makes the "start from
      // existing attestations" preview see only canonical attestations made after this block.
      // Widen deliberately, not by default.
      [`PONDER_EAS_START_BLOCK_${chainId}`]: blocks.easStartBlock,
      ...(blocks.startBlock === undefined
        ? {}
        : { [`PONDER_START_BLOCK_${chainId}`]: blocks.startBlock }),
      PONDER_VIEWS_SCHEMA: 'trust-graph',
      PONDER_PORT: '65421',
      [`PONDER_RPC_URL_${chainId}`]: ctx.shared[target.shared.rpcPrimary],
      [`PONDER_RPC_URLS_${chainId}`]: indexerRpcPool(target),
      [`PONDER_ETH_GET_LOGS_BLOCK_RANGE_${chainId}`]: '10',
      IPFS_GATEWAY: ctx.shared[target.shared.ipfsGateway],
      EAS_OFFCHAIN_GATEWAYS: ctx.shared[target.shared.ipfsGateway],
      FRONTEND_URL: target.frontendUrl,
    },
  })

  const operator = service('operator', {
    source: repository,
    build: { watchPatterns: operatorWatchPaths(target) },
    deploy: {
      limitOverride: {
        containers: { cpu: 0.5, memoryBytes: target.operatorMemoryBytes },
      },
    },
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
      // NOT the shared Alchemy RPC: its free tier caps eth_getLogs at a 10-block range, and the
      // operator's registry scan (hardcoded 10k-block chunks in zk/operator/src/chain.rs) can
      // never fit. The indexer survives that cap only because Ponder chunks to 10 blocks.
      // Publicnode answers the full-range scan; swap in a paid endpoint here when one exists.
      RPC_URL: target.operatorRpcUrl,
      SUBMITTER_PRIVATE_KEY: ctx.shared[target.shared.submitterPrivateKey],
      NETWORK_PRIVATE_KEY: ctx.shared[target.shared.networkPrivateKey],
      IPFS_PIN_API: 'https://uploads.pinata.cloud/v3/files',
      IPFS_PIN_API_KEY: ctx.shared[target.shared.ipfsPinApiKey],
      IPFS_GATEWAY: ctx.shared[target.shared.ipfsGateway],
      // Row-specific literals, e.g. the DEPLOY_TARGET build arg that selects the operator profile.
      ...target.operatorEnv,
      ...(target.shared.operatorAlertWebhook === undefined
        ? {}
        : {
            OPERATOR_ALERT_WEBHOOK:
              ctx.shared[target.shared.operatorAlertWebhook],
          }),
    },
  })

  const dataPlane = group('Data plane', [database, indexer])
  const proving = group('Proof service', [operatorState, operator])

  return project(target.projectName, {
    resources: [dataPlane, proving],
  })
}
