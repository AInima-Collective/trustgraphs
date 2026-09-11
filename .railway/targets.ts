import fs from 'node:fs'

// One row per Railway project. `railway.ts` looks the linked project's name up in TARGETS and
// builds the topology from the row it finds, so a plan can never carry one chain's parameters
// into the other chain's project. A third chain is one more row plus its deployments/<target>.json.

export type DeployTarget = 'sepolia' | 'mainnet'

export interface StartBlocks {
  // PONDER_EAS_START_BLOCK_<chainId>: where the canonical EAS contract and Schema Registry sources
  // start. Left at Ponder's default of 0 they crawl the chain from genesis (see lib/project.ts).
  easStartBlock: string
  // PONDER_START_BLOCK_<chainId>: where the root Trustgraphs sources start. Optional: when omitted
  // the indexer falls back to the manifest's firstDeploymentBlock, which is what the live Sepolia
  // service relies on. Setting it there would be a new variable, so the Sepolia row leaves it out.
  startBlock?: string
}

export interface RailwayTarget {
  // The Railway project this row describes; `project()` is named from it.
  projectName: string
  // DEPLOY_TARGET as the indexer, the operator profile and deployments/<target>.json spell it.
  deployTarget: DeployTarget
  chainId: number
  // The git branch the GitHub-sourced services follow.
  branch: string
  region: {
    database: string
    // The operator has no region of its own: Railway places a volume-backed service with its volume.
    operatorState: string
    indexer: string
  }
  // PONDER_DATABASE_SCHEMA. Bump it with every indexer build; PONDER_VIEWS_SCHEMA stays stable.
  writerSchema: string
  // Resolved when the row is planned rather than stored: the mainnet blocks come from
  // deployments/mainnet.json, which carries null until the contracts are deployed.
  startBlocks: () => StartBlocks
  // Public fallbacks appended after the metered primary in PONDER_RPC_URLS_<chainId>. Each must be
  // on a host independent of the primary's; the indexer launcher refuses to start otherwise.
  rpcFallbacks: readonly string[]
  // RPC_URL for the operator. See the eth_getLogs note on that variable in lib/project.ts.
  operatorRpcUrl: string
  // The public frontend origin: what the indexer pings for cache revalidation.
  frontendUrl: string
  // The indexer's custom domain (the frontend's PONDER_URL), so it stops depending on a generated
  // Railway hostname. Railway IaC cannot register a custom domain: add it on the indexer service in
  // the dashboard, point the DNS record at the target Railway shows, then record it here so the
  // plan stays a no-op. Absent until that has happened.
  apiDomain?: string
  // Names of the Railway shared variables the row reads. The values live only in Railway, sealed.
  shared: {
    rpcPrimary: string
    ipfsGateway: string
    ipfsPinApiKey: string
    submitterPrivateKey: string
    networkPrivateKey: string
    // Passed to the operator as OPERATOR_ALERT_WEBHOOK when set.
    operatorAlertWebhook?: string
  }
  // Literal service variables set only on this row's operator.
  operatorEnv: Readonly<Record<string, string>>
  indexerMemoryBytes: number
  operatorMemoryBytes: number
}

// Railway bills actual usage rather than a reserved machine size. Its current minimum per-replica
// ceiling is 0.5 vCPU and 512 MiB; start a new service there and raise only the service that
// proves it needs more. Both application services have.

// The indexer is the one service that has outgrown that minimum. Its start path chains three Node
// processes - this launcher, pnpm, and Ponder itself - beside esbuild's native child while Ponder
// bundles the config, every indexing function, and the API. Node also sizes its heap from the
// host's RAM rather than from the container limit, so at 512 MB it grows past the ceiling and is
// killed before it writes its first line.
export const indexerMemoryBytes = 1024 * 1024 * 1024

// The operator proved it needs more the same way: startup derives the vkey for every compiled-in
// SP1 guest once (zk/operator/src/run.rs), and that setup peaks past 512 MB. Railway metrics show
// memory pinned at exactly the 512 MB ceiling with the container OOM-killed and restarted every
// ~25 seconds, before the health listener (which binds after vkey derivation) ever comes up.
// 2 decimal GB, exactly what serviceInstanceLimitsUpdate(memoryGB: 2.0) set live; a GiB value
// here would leave `config plan` forever proposing a 147 MB no-op change.
export const operatorMemoryBytes = 2_000_000_000

// Reads deployments/<target>.json when the row is planned, not when this module loads, so the
// Sepolia plan never depends on the mainnet manifest and vice versa.
export const manifestFirstBlock = (target: DeployTarget): string => {
  const file = new URL(`../deployments/${target}.json`, import.meta.url)
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    firstDeploymentBlock: number | null
  }
  if (manifest.firstDeploymentBlock == null) {
    throw new Error(
      `deployments/${target}.json has no firstDeploymentBlock: the ${target} contracts are not ` +
        `deployed, so there is no block for the ${target} indexer to start from. Deploy and ` +
        `record the manifest before planning the ${target} Railway project.`
    )
  }
  return String(manifest.firstDeploymentBlock)
}

// The Sepolia regions record where the first production applies actually landed, not a
// preference: Postgres in us-west2, the operator volume and indexer replica in us-east4. Moving
// either stateful side is destructive (`config apply` would recreate the volume or the database),
// so a clean plan requires describing the split as it exists. Reunify regions only as a deliberate
// migration, not by editing a constant.
const sepolia: RailwayTarget = {
  projectName: 'trustgraphs-sepolia',
  deployTarget: 'sepolia',
  chainId: 11155111,
  branch: 'main',
  region: {
    database: 'us-west2',
    operatorState: 'us-east4-eqdc4a',
    indexer: 'us-east4-eqdc4a',
  },
  // v7: the v0.1 generation replaces every Trustgraphs contract (new registry, factories and
  // vault from block 11670854) and carries the Ponder 0.17 upgrade, which changes the indexer
  // build fingerprint. Ponder refuses to reuse a schema written by a different app build, so
  // the new writer backfills into a fresh schema. v6 was abandoned mid-backfill on 2026-09-10
  // when the canonical EAS crawl was bounded. The views schema stays stable and continues
  // pointing at the previous writer until the new one is ready.
  writerSchema: 'trustgraph_sepolia_v7',
  // The generation's first block (deployments/sepolia.json firstDeploymentBlock), kept as the
  // literal the live service carries. Widen deliberately, not by default; see the crawl note on
  // PONDER_EAS_START_BLOCK in lib/project.ts.
  startBlocks: () => ({ easStartBlock: '11670854' }),
  rpcFallbacks: [
    'https://ethereum-sepolia-rpc.publicnode.com',
    'https://sepolia.gateway.tenderly.co',
  ],
  operatorRpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
  // The testnet move (2026-09-10): the Sepolia app lives on the testnet subdomain.
  frontendUrl: 'https://testnet.trustgraphs.xyz',
  // apiDomain: 'api.testnet.trustgraphs.xyz' once registered in the dashboard (testnet move, step 6).
  shared: {
    rpcPrimary: 'RPC_URL_11155111_0',
    ipfsGateway: 'IPFS_GATEWAY',
    ipfsPinApiKey: 'IPFS_PIN_API_KEY',
    submitterPrivateKey: 'SUBMITTER_PRIVATE_KEY',
    networkPrivateKey: 'NETWORK_PRIVATE_KEY',
  },
  // .railway/operator.Dockerfile defaults its DEPLOY_TARGET build arg to sepolia, so this service
  // needs no variable and its plan stays a no-op.
  operatorEnv: {},
  indexerMemoryBytes,
  operatorMemoryBytes,
}

const mainnet: RailwayTarget = {
  projectName: 'trustgraphs-mainnet',
  deployTarget: 'mainnet',
  chainId: 1,
  // A long-lived branch fast-forwarded on purpose, so "what runs on mainnet" is a git ref and a
  // merge to main cannot rebuild the mainnet indexer.
  branch: 'mainnet',
  // Everything in one region; the Sepolia split above is a historical accident.
  region: {
    database: 'us-west2',
    operatorState: 'us-west2',
    indexer: 'us-west2',
  },
  writerSchema: 'trustgraph_mainnet_v1',
  // Both cursors start at the generation's first block, read from the manifest when planned.
  startBlocks: () => {
    const block = manifestFirstBlock('mainnet')
    return { easStartBlock: block, startBlock: block }
  },
  rpcFallbacks: [
    'https://ethereum-rpc.publicnode.com',
    'https://mainnet.gateway.tenderly.co',
  ],
  // Same reasoning as Sepolia: the metered primary caps eth_getLogs at a 10-block range that the
  // operator's registry scan can never fit, and publicnode answers the full-range scan.
  operatorRpcUrl: 'https://ethereum-rpc.publicnode.com',
  frontendUrl: 'https://trustgraphs.xyz',
  // apiDomain: 'api.trustgraphs.xyz' once registered in the dashboard (phase 7).
  shared: {
    rpcPrimary: 'RPC_URL_1_0',
    ipfsGateway: 'IPFS_GATEWAY',
    ipfsPinApiKey: 'IPFS_PIN_API_KEY',
    submitterPrivateKey: 'SUBMITTER_PRIVATE_KEY',
    networkPrivateKey: 'NETWORK_PRIVATE_KEY',
    operatorAlertWebhook: 'OPERATOR_ALERT_WEBHOOK',
  },
  // Railway exposes service variables to the Docker build as build args, so this makes
  // .railway/operator.Dockerfile copy deployments/operator.mainnet.toml and deployments/mainnet.json.
  operatorEnv: { DEPLOY_TARGET: 'mainnet' },
  indexerMemoryBytes,
  operatorMemoryBytes,
}

// Keyed by the Railway project name exactly as the dashboard shows it (the Sepolia project was
// renamed from its auto-generated name on 2026-09-10; a rename keeps the project id and every
// resource).
export const TARGETS: Readonly<Record<string, RailwayTarget>> = {
  'trustgraphs-sepolia': sepolia,
  'trustgraphs-mainnet': mainnet,
}
