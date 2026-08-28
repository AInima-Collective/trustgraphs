import fs from 'fs'
import path from 'path'

import { createConfig, factory } from 'ponder'
import { Hex, getAbiItem } from 'viem'

import {
  compositionAccumulatorAbi,
  trustComposeFactoryAbi,
  trustComposeParamsControllerAbi,
} from './abis/composition'
import { contributionsFactoryAbi } from './abis/contributionsFactory'
import { contributionsParamsControllerAbi } from './abis/contributionsParamsController'
import { easOffchainAnchorRegistryAbi } from './abis/easOffchainAnchorRegistry'
import { erc8004IdentityRegistryAbi } from './abis/erc8004IdentityRegistry'
import { erc8004ReputationRegistryAbi } from './abis/erc8004ReputationRegistry'
import { graphLineageRegistryAbi } from './abis/graphLineage'
import { provingVaultAbi } from './abis/provingVault'
import { trustgraphsFactoryAbi } from './abis/trustgraphsFactory'
import {
  instanceRegistryAbi,
  instanceRegistryParamsAbi,
  trustgraphsParamsControllerAbi,
} from './abis/trustgraphsParamsController'
import {
  weightedPriorParamsControllerAbi,
  weightedTrustgraphsFactoryAbi,
} from './abis/weightedPrior'
import {
  loadReleaseManifest,
  releaseManifestToDeploymentSummary,
} from '../../contracts/deploy/release-manifest'
import { loadTargetEnvironment } from '../../scripts/load-env.cjs'
import {
  anchorRegistryAbi,
  contributionResolverAbi,
  easIndexerResolverAbi,
  gnosisSafeAbi,
  governedTrustgraphsFactoryAbi,
  merkleFundDistributorAbi,
  merkleGovModuleAbi,
  merkleSnapshotAbi,
  signerSyncModuleDeployerAbi,
  signerSyncZkModuleAbi,
} from '../frontend/lib/contract-abis'

/**
 * The deployment summary is a generated, machine-local file whose entries vary by which instances
 * are deployed (a lane-2-only hypercerts box has just merkleSnapshot + anchorRegistry; a
 * trust-graph box has the EAS resolver, gov module, distributor, and Safe). Type it explicitly so
 * typechecking doesn't depend on the box's current JSON shape.
 */
interface DeployedNetwork {
  id?: string
  name?: string
  /** Program discriminator; absent = the address-keyed trust-graph vouching program. */
  program?: string
  contracts: {
    merkleSnapshot?: string
    easIndexerResolver?: string
    merkleFundDistributor?: string
    merkleGovModule?: string
    anchorRegistry?: string
    contributionResolver?: string
    safe?: { proxy?: string }
  }
}
type DeploymentSummary = {
  networks: DeployedNetwork[]
  eas?: { eas?: string; schema_registry?: string; schema_registrar?: string }
  /** `.docker/factory_deploy.json`, present once `DeployFactory` has run on this box. */
  factory?: { factory?: string; instance_registry?: string }
  governedFactory?: {
    governed_factory?: string
    signer_sync_deployer?: string
  }
  /** The fast (EPOCH_FLOOR = 1) factory generation. Same contracts and event surface as
   *  `factory` / `governedFactory`, so both generations ride the same sources as address
   *  arrays; only present once the fast pair is recorded in the release manifest. */
  factoryFast?: { factory?: string }
  governedFactoryFast?: { governed_factory?: string }
  /** Fast (EPOCH_FLOOR = 1) generations of the weighted / compose / contributions factories.
   *  Same contracts and event surfaces as their originals, so each pair rides its family's
   *  sources as an address array, exactly like `factoryFast`. */
  weightedFactoryFast?: { weighted_factory?: string }
  governedWeightedFactoryFast?: { governed_weighted_factory?: string }
  trustComposeFactoryFast?: { trust_compose_factory?: string }
  governedComposeFactoryFast?: { governed_compose_factory?: string }
  contributionsFactoryFast?: { contributions_factory?: string }
  /** Governed wrappers for the weighted / compose programs. They share the governed factory's
   *  Safe singletons and helper deployers and emit the SAME `GovernedInstanceCreated` signature,
   *  so their children ride the existing governed child sources. */
  governedWeightedFactory?: { governed_weighted_factory?: string }
  governedComposeFactory?: { governed_compose_factory?: string }
  weightedFactory?: { weighted_factory?: string }
  // One summary key per factory, agreed by both consumers: this matches the contract name and
  // what packages/frontend/scripts/generate-config.ts reads (`trustComposeFactory.trust_compose_factory`),
  // written by `DeployTrustComposeFactory` via contracts/deploy/env.ts.
  trustComposeFactory?: { trust_compose_factory?: string }
  contributionsFactory?: { contributions_factory?: string }
  graphLineage?: { registry?: string }
}

loadTargetEnvironment({
  repositoryRoot: path.join(__dirname, '../..'),
  higherPriorityFiles: [path.join(__dirname, '.env.local')],
})

const deploymentStage =
  process.env.DEPLOY_STAGE?.trim().toLowerCase() ?? 'development'
const deploymentTarget =
  process.env.DEPLOY_TARGET?.trim().toLowerCase() ?? 'local'
if (!['development', 'production'].includes(deploymentStage)) {
  throw new Error('DEPLOY_STAGE must be development or production')
}
if (!['local', 'sepolia'].includes(deploymentTarget)) {
  throw new Error('DEPLOY_TARGET must be local or sepolia')
}
if ((deploymentStage === 'development') !== (deploymentTarget === 'local')) {
  throw new Error(
    `Invalid deployment profile ${deploymentStage}/${deploymentTarget}`
  )
}

export const IS_PRODUCTION = deploymentStage === 'production'
const IS_SEPOLIA = deploymentTarget === 'sepolia'
const IS_LOCAL = deploymentTarget === 'local'
const CORE_CHAIN = IS_SEPOLIA ? 'sepolia' : 'local'
const releaseManifest = IS_SEPOLIA
  ? loadReleaseManifest(
      path.join(__dirname, '../../deployments/sepolia.json'),
      {
        requireComplete: true,
      }
    )
  : undefined
const deploymentSummary = (
  releaseManifest
    ? releaseManifestToDeploymentSummary(releaseManifest)
    : JSON.parse(
        fs.readFileSync(
          path.join(__dirname, '../../.docker/deployment_summary.json'),
          'utf8'
        )
      )
) as DeploymentSummary

const requiredEnv = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const blockNumberEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer, got "${raw}"`)
  }
  return value
}

const positiveIntegerEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer, got "${raw}"`)
  }
  return value
}

const rpcUrlsEnv = (
  primaryName: string,
  fallbacksName: string
): string | string[] => {
  const primary = requiredEnv(primaryName)
  const urls = [
    primary,
    ...(process.env[fallbacksName] ?? '')
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean),
  ].filter((value, index, values) => values.indexOf(value) === index)

  for (const value of urls) {
    let protocol: string
    try {
      protocol = new URL(value).protocol
    } catch {
      throw new Error(`${fallbacksName} contains an invalid URL`)
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error(`${fallbacksName} only accepts HTTP(S) RPC URLs`)
    }
  }

  return urls.length === 1 ? primary : urls
}

const LOCAL_RPC_URL =
  process.env.PONDER_RPC_URL_31337 ??
  process.env.PONDER_RPC_URL ??
  process.env.RPC_URL ??
  'http://127.0.0.1:8545'
const LOCAL_WS_URL =
  process.env.PONDER_WS_URL_31337 ??
  process.env.PONDER_WS_URL ??
  LOCAL_RPC_URL.replace(/^http/, 'ws')

// Dev start block for the ROOT sources — the ones whose addresses are known before any event is
// read (the factory itself, and the non-factory program instances). On a plain local anvil this is
// ~genesis (1). On a MAINNET FORK the contracts live just above the fork block, so starting at 1
// would backfill millions of pre-fork blocks; set PONDER_START_BLOCK=<fork block> (see
// LOCAL_TESTING.md §Indexer). Factory CHILDREN (every trust-graph instance's snapshot, resolver and
// distributor) do NOT use this: Ponder starts each child at the block its `InstanceCreated` was
// emitted, which is both exact and self-maintaining. Contracts whose events only occur after the
// indexer starts (gov/safe) use 'latest' and need no start block.
const DEV_START_BLOCK = blockNumberEnv('PONDER_START_BLOCK', 1)

const SEPOLIA_START_BLOCK = blockNumberEnv(
  'PONDER_START_BLOCK_11155111',
  releaseManifest?.firstDeploymentBlock ?? 0
)
const CORE_START_BLOCK = IS_SEPOLIA ? SEPOLIA_START_BLOCK : DEV_START_BLOCK

/**
 * ERC-8004 is a local research fixture. Public deployment profiles do not accept an arbitrary
 * registry address through configuration.
 */
const ERC8004_IDENTITY_REGISTRY = IS_LOCAL
  ? (process.env.ERC8004_IDENTITY_REGISTRY_ADDRESS_31337 as Hex | undefined)
  : undefined
const ERC8004_START_BLOCK = DEV_START_BLOCK
const ERC8004_REPUTATION_REGISTRY = IS_LOCAL
  ? (process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS_31337 as Hex | undefined)
  : undefined
const ERC8004_REPUTATION_START_BLOCK = DEV_START_BLOCK
if (ERC8004_REPUTATION_REGISTRY && !ERC8004_IDENTITY_REGISTRY) {
  throw new Error(
    'ERC8004_IDENTITY_REGISTRY_ADDRESS_31337 is required when the local Reputation Registry is enabled'
  )
}

/**
 * The permissionless instance factory (research/INSTANCE_FACTORY.md §3). When it is deployed, the
 * chain — not this file — is the trust-graph catalog: every instance's `MerkleSnapshot`,
 * `EASIndexerResolver` and `MerkleFundDistributor` is discovered from `InstanceCreated` through a
 * Ponder `factory()` source, so a network created a minute ago is indexed with no config edit, no
 * restart, and no redeploy.
 */
/**
 * The shared `ProvingVault`. One per chain, not per instance: accounts are keyed by `instanceId`
 * inside it. Absent from the summary on a box that has not deployed one, in which case the source
 * is disabled rather than pointed at a zero address.
 */
const PROVING_VAULT = (deploymentSummary as { provingVault?: string })
  .provingVault as Hex | undefined

const TRUSTGRAPHS_FACTORY = deploymentSummary.factory?.factory as
  | Hex
  | undefined
const INSTANCE_REGISTRY = deploymentSummary.factory?.instance_registry as
  | Hex
  | undefined
const TRUSTGRAPHS_FACTORY_FAST = deploymentSummary.factoryFast?.factory as
  | Hex
  | undefined
/** Both trust-graph factory generations. Every factory-sourced discovery (InstanceCreated,
 *  ParamsControllerCreated, OffchainEasLaneCreated, DistributorAttached) listens to the whole
 *  array so networks minted by either generation are indexed identically. */
const TRUSTGRAPHS_FACTORIES = [
  TRUSTGRAPHS_FACTORY,
  TRUSTGRAPHS_FACTORY_FAST,
].filter((address): address is Hex => address !== undefined)
const GOVERNED_FACTORY = deploymentSummary.governedFactory?.governed_factory as
  | Hex
  | undefined
const GOVERNED_FACTORY_FAST = deploymentSummary.governedFactoryFast
  ?.governed_factory as Hex | undefined
const GOVERNED_WEIGHTED_FACTORY = deploymentSummary.governedWeightedFactory
  ?.governed_weighted_factory as Hex | undefined
const GOVERNED_WEIGHTED_FACTORY_FAST = deploymentSummary
  .governedWeightedFactoryFast?.governed_weighted_factory as Hex | undefined
const GOVERNED_COMPOSE_FACTORY = deploymentSummary.governedComposeFactory
  ?.governed_compose_factory as Hex | undefined
const GOVERNED_COMPOSE_FACTORY_FAST = deploymentSummary
  .governedComposeFactoryFast?.governed_compose_factory as Hex | undefined
/**
 * Every governed wrapper on this chain, both generations of each. All emit the same
 * `GovernedInstanceCreated(instanceId, creator, safe, merkleGovModule, snapshot)` signature, so
 * one `factory()` source with an address ARRAY discovers every wrapper's Safe and gov module and
 * `gov.ts`/`safe.ts` handlers apply unchanged.
 */
const GOVERNED_WRAPPERS = [
  GOVERNED_FACTORY,
  GOVERNED_FACTORY_FAST,
  GOVERNED_WEIGHTED_FACTORY,
  GOVERNED_WEIGHTED_FACTORY_FAST,
  GOVERNED_COMPOSE_FACTORY,
  GOVERNED_COMPOSE_FACTORY_FAST,
].filter((address): address is Hex => address !== undefined)
/** Both governed trust-graph wrapper generations, one source: same ABI, same handlers. */
const GOVERNED_TRUSTGRAPHS_FACTORIES = [
  GOVERNED_FACTORY,
  GOVERNED_FACTORY_FAST,
].filter((address): address is Hex => address !== undefined)
const SIGNER_SYNC_DEPLOYER = deploymentSummary.governedFactory
  ?.signer_sync_deployer as Hex | undefined
const CHAIN_ID = IS_SEPOLIA ? 11155111 : 31337
const WEIGHTED_FACTORY =
  (process.env[`WEIGHTED_FACTORY_ADDRESS_${CHAIN_ID}`]?.trim() as
    | Hex
    | undefined) ??
  (deploymentSummary.weightedFactory?.weighted_factory as Hex | undefined)
const WEIGHTED_FACTORY_FAST = deploymentSummary.weightedFactoryFast
  ?.weighted_factory as Hex | undefined
/** Both weighted factory generations; every weighted factory-sourced discovery rides the array. */
const WEIGHTED_FACTORIES = [WEIGHTED_FACTORY, WEIGHTED_FACTORY_FAST].filter(
  (address): address is Hex => address !== undefined
)
const COMPOSITION_FACTORY =
  (process.env[`TRUST_COMPOSE_FACTORY_ADDRESS_${CHAIN_ID}`]?.trim() as
    | Hex
    | undefined) ??
  (deploymentSummary.trustComposeFactory?.trust_compose_factory as
    | Hex
    | undefined)
const COMPOSITION_FACTORY_FAST = deploymentSummary.trustComposeFactoryFast
  ?.trust_compose_factory as Hex | undefined
const COMPOSITION_FACTORIES = [
  COMPOSITION_FACTORY,
  COMPOSITION_FACTORY_FAST,
].filter((address): address is Hex => address !== undefined)
const CONTRIBUTIONS_FACTORY =
  (process.env[`CONTRIBUTIONS_FACTORY_ADDRESS_${CHAIN_ID}`]?.trim() as
    | Hex
    | undefined) ??
  (deploymentSummary.contributionsFactory?.contributions_factory as
    | Hex
    | undefined)
const CONTRIBUTIONS_FACTORY_FAST = deploymentSummary.contributionsFactoryFast
  ?.contributions_factory as Hex | undefined
const CONTRIBUTIONS_FACTORIES = [
  CONTRIBUTIONS_FACTORY,
  CONTRIBUTIONS_FACTORY_FAST,
].filter((address): address is Hex => address !== undefined)
const GRAPH_LINEAGE_REGISTRY =
  (process.env[`GRAPH_LINEAGE_REGISTRY_ADDRESS_${CHAIN_ID}`]?.trim() as
    | Hex
    | undefined) ??
  (deploymentSummary.graphLineage?.registry as Hex | undefined)

/**
 * Whether to discover trust-graph children from the factory. Discovery follows the deployment
 * artifact, not the environment: a production factory must behave exactly like a development one.
 * A box whose deploy chain never ran `DeployFactory` (for example a lane-2-only hypercerts box)
 * still falls back to the static lists.
 */
const FACTORY_DISCOVERY = TRUSTGRAPHS_FACTORY !== undefined

/** The frozen discovery event. Every child address below is one of its arguments. */
const INSTANCE_CREATED = getAbiItem({
  abi: trustgraphsFactoryAbi,
  name: 'InstanceCreated',
})
const PARAMS_CONTROLLER_CREATED = getAbiItem({
  abi: trustgraphsFactoryAbi,
  name: 'ParamsControllerCreated',
})
const OFFCHAIN_EAS_LANE_CREATED = getAbiItem({
  abi: trustgraphsFactoryAbi,
  name: 'OffchainEasLaneCreated',
})
const PARAMS_AUTHORITY_UPDATED = getAbiItem({
  abi: instanceRegistryParamsAbi,
  name: 'ParamsAuthorityUpdated',
})
const GOVERNED_INSTANCE_CREATED = getAbiItem({
  abi: governedTrustgraphsFactoryAbi,
  name: 'GovernedInstanceCreated',
})
const SIGNER_SYNC_MODULE_CONFIGURED = getAbiItem({
  abi: signerSyncModuleDeployerAbi,
  name: 'SignerSyncModuleConfigured',
})
const WEIGHTED_PARAMS_CONTROLLER_CREATED = getAbiItem({
  abi: weightedTrustgraphsFactoryAbi,
  name: 'WeightedParamsControllerCreated',
})
const WEIGHTED_INSTANCE_CREATED = getAbiItem({
  abi: weightedTrustgraphsFactoryAbi,
  name: 'WeightedInstanceCreated',
})
const COMPOSITION_CONTROLLER_CREATED = getAbiItem({
  abi: trustComposeFactoryAbi,
  name: 'TrustComposeParamsControllerCreated',
})
const COMPOSITION_INSTANCE_CREATED = getAbiItem({
  abi: trustComposeFactoryAbi,
  name: 'TrustComposeInstanceCreated',
})
const CONTRIBUTIONS_INSTANCE_CREATED = getAbiItem({
  abi: contributionsFactoryAbi,
  name: 'ContributionsInstanceCreated',
})

/**
 * A `factory()` address source for one of `InstanceCreated`'s child-contract arguments. Children
 * are indexed from their creation block, so nothing here needs a start block of its own.
 *
 * `distributor` is `address(0)` for an instance created without one; a zero address simply never
 * matches a log, so no special-casing is needed.
 */
const instanceChildren = (parameter: 'snapshot' | 'resolver' | 'distributor') =>
  factory({
    address: TRUSTGRAPHS_FACTORIES,
    event: INSTANCE_CREATED,
    parameter,
    startBlock: CORE_START_BLOCK,
  })

const paramsControllers = () =>
  factory({
    address: TRUSTGRAPHS_FACTORIES,
    event: PARAMS_CONTROLLER_CREATED,
    parameter: 'controller',
    startBlock: CORE_START_BLOCK,
  })

const easOffchainRegistries = () =>
  factory({
    address: TRUSTGRAPHS_FACTORIES,
    event: OFFCHAIN_EAS_LANE_CREATED,
    parameter: 'registry',
    startBlock: CORE_START_BLOCK,
  })

const migratedParamsControllers = () =>
  factory({
    address: INSTANCE_REGISTRY!,
    event: PARAMS_AUTHORITY_UPDATED,
    parameter: 'newAuthority',
    startBlock: CORE_START_BLOCK,
  })

const governedChildren = (parameter: 'safe' | 'merkleGovModule') =>
  factory({
    // All governed wrappers share one child source: the discovery event signature is identical
    // across the trust-graph, weighted, and compose wrappers by construction.
    address: GOVERNED_WRAPPERS,
    event: GOVERNED_INSTANCE_CREATED,
    parameter,
    startBlock: CORE_START_BLOCK,
  })

const governedSignerModules = () =>
  factory({
    address: SIGNER_SYNC_DEPLOYER!,
    event: SIGNER_SYNC_MODULE_CONFIGURED,
    parameter: 'signerSyncModule',
    startBlock: CORE_START_BLOCK,
  })

const weightedParamsControllers = () =>
  factory({
    address: WEIGHTED_FACTORIES,
    event: WEIGHTED_PARAMS_CONTROLLER_CREATED,
    parameter: 'controller',
    startBlock: CORE_START_BLOCK,
  })

const weightedChildren = (parameter: 'snapshot' | 'resolver' | 'distributor') =>
  factory({
    address: WEIGHTED_FACTORIES,
    event: WEIGHTED_INSTANCE_CREATED,
    parameter,
    startBlock: CORE_START_BLOCK,
  })

/**
 * Fund distributors attached to an existing instance after creation
 * (`attachDistributor`). One source covers all three base factories: the
 * `DistributorAttached(instanceId, distributor, distributorToken)` signature is identical by
 * construction, and `factory()` takes an address array.
 */
const BASE_FACTORIES = [
  ...TRUSTGRAPHS_FACTORIES,
  ...WEIGHTED_FACTORIES,
  ...COMPOSITION_FACTORIES,
].filter((address): address is Hex => address !== undefined)

const attachedDistributors = () =>
  factory({
    address: BASE_FACTORIES,
    event: getAbiItem({
      abi: trustgraphsFactoryAbi,
      name: 'DistributorAttached',
    }),
    parameter: 'distributor',
    startBlock: CORE_START_BLOCK,
  })

const compositionControllers = () =>
  factory({
    address: COMPOSITION_FACTORIES,
    event: COMPOSITION_CONTROLLER_CREATED,
    parameter: 'controller',
    startBlock: CORE_START_BLOCK,
  })

const compositionChildren = (
  parameter: 'snapshot' | 'accumulator' | 'distributor'
) =>
  factory({
    address: COMPOSITION_FACTORIES,
    event: COMPOSITION_INSTANCE_CREATED,
    parameter,
    startBlock: CORE_START_BLOCK,
  })

const contributionsChildren = (
  parameter: 'resolver' | 'snapshot' | 'distributor'
) =>
  factory({
    address: CONTRIBUTIONS_FACTORIES,
    event: CONTRIBUTIONS_INSTANCE_CREATED,
    parameter,
    startBlock: CORE_START_BLOCK,
  })

/** Is this summary entry a trust-graph (vouching) network? Absent `program` means yes. */
const isTrustgraphs = (network: DeployedNetwork) =>
  (network.program ?? 'trust-graph') === 'trust-graph'

/**
 * Deployed addresses under `contracts[key]`, optionally restricted to a subset of the catalog.
 * `flatMap` because entries are program-shaped: a lane-2-only (hypercerts) entry has no EAS
 * resolver, a contributions entry has no gov module, and so on.
 */
const deployedAddresses = (
  key: 'merkleSnapshot' | 'easIndexerResolver' | 'merkleFundDistributor',
  filter: (network: DeployedNetwork) => boolean = () => true
): Hex[] =>
  deploymentSummary.networks
    .filter(filter)
    .flatMap((network) => (network.contracts[key] as Hex) || [])

/**
 * The non-factory program instances (contributions, hypercerts). These have their own
 * `MerkleSnapshot`/`MerkleFundDistributor` deployed by their own scripts — they are not minted by
 * the trust-graph factory in v1 — so they keep static sources. Empty (and their sources disabled)
 * when factory discovery is off, because then the main sources already list every address.
 */
const otherProgram = (network: DeployedNetwork) => !isTrustgraphs(network)
const programSnapshots = FACTORY_DISCOVERY
  ? deployedAddresses('merkleSnapshot', otherProgram)
  : []
const programFundDistributors = FACTORY_DISCOVERY
  ? deployedAddresses('merkleFundDistributor', otherProgram)
  : []

export default createConfig({
  ordering: 'multichain',
  chains: {
    ...(!IS_PRODUCTION
      ? {
          local: {
            id: 31337,
            rpc: LOCAL_RPC_URL,
            ws: LOCAL_WS_URL,
          },
        }
      : {
          sepolia: {
            id: 11155111,
            // Ponder treats an RPC array as an ordered, health-aware backend pool. Operators
            // keep the private primary separate from a comma/newline-delimited failover list.
            rpc: rpcUrlsEnv(
              'PONDER_RPC_URL_11155111',
              'PONDER_RPC_URLS_11155111'
            ),
            // Provider limits vary dramatically: the current free primary accepts only ten
            // blocks, while the verified public fallback accepts the full deployment range.
            // Keep the restrictive default safe and make production tuning explicit. Ponder
            // discovers request-rate limits dynamically; its old maxRequestsPerSecond option is
            // deprecated and ignored, so do not imply it offers a hard throttle.
            ethGetLogsBlockRange: positiveIntegerEnv(
              'PONDER_ETH_GET_LOGS_BLOCK_RANGE_11155111',
              10
            ),
            ...(process.env.PONDER_WS_URL_11155111
              ? { ws: process.env.PONDER_WS_URL_11155111 }
              : {}),
          },
        }),
  },
  // Missing score bytes are an availability problem, not a chain-indexing failure. This bounded
  // heartbeat drains the durable off-chain queue without coupling retries to another root event.
  blocks: {
    scoreBlobRetry: {
      chain: CORE_CHAIN,
      startBlock: CORE_START_BLOCK,
      interval: 5,
    },
  },
  contracts: {
    graphLineageRegistry: {
      abi: graphLineageRegistryAbi,
      startBlock: CORE_START_BLOCK,
      chain: GRAPH_LINEAGE_REGISTRY
        ? { [CORE_CHAIN]: { address: GRAPH_LINEAGE_REGISTRY } }
        : {},
    },
    // Authenticated program/output-domain discovery. Only this explicitly configured registry can
    // create score bindings; catalog metadata and score-key shape are never discovery sources.
    instanceRegistry: {
      abi: instanceRegistryAbi,
      startBlock: CORE_START_BLOCK,
      chain: INSTANCE_REGISTRY
        ? { [CORE_CHAIN]: { address: INSTANCE_REGISTRY } }
        : {},
    },
    erc8004IdentityRegistry: {
      abi: erc8004IdentityRegistryAbi,
      startBlock: ERC8004_START_BLOCK,
      chain: ERC8004_IDENTITY_REGISTRY
        ? { [CORE_CHAIN]: { address: ERC8004_IDENTITY_REGISTRY } }
        : {},
    },
    erc8004ReputationRegistry: {
      abi: erc8004ReputationRegistryAbi,
      startBlock: ERC8004_REPUTATION_START_BLOCK,
      chain: ERC8004_REPUTATION_REGISTRY
        ? { [CORE_CHAIN]: { address: ERC8004_REPUTATION_REGISTRY } }
        : {},
    },
    // The instance directory itself: `InstanceCreated` is both the catalog row (src/factory.ts →
    // the `instance` table, which replaces config/networks.json for trust-graph networks) and the
    // address source for the three child contracts below.
    trustgraphsFactory: {
      abi: trustgraphsFactoryAbi,
      startBlock: CORE_START_BLOCK,
      chain: FACTORY_DISCOVERY
        ? { [CORE_CHAIN]: { address: TRUSTGRAPHS_FACTORIES } }
        : {},
    },
    weightedTrustgraphsFactory: {
      abi: weightedTrustgraphsFactoryAbi,
      startBlock: CORE_START_BLOCK,
      chain:
        WEIGHTED_FACTORIES.length > 0
          ? { [CORE_CHAIN]: { address: WEIGHTED_FACTORIES } }
          : {},
    },
    weightedPriorParamsController: {
      abi: weightedPriorParamsControllerAbi,
      startBlock: CORE_START_BLOCK,
      chain:
        WEIGHTED_FACTORIES.length > 0
          ? { [CORE_CHAIN]: { address: weightedParamsControllers() } }
          : {},
    },
    weightedEasIndexerResolver: {
      abi: easIndexerResolverAbi,
      startBlock: CORE_START_BLOCK,
      chain:
        WEIGHTED_FACTORIES.length > 0
          ? { [CORE_CHAIN]: { address: weightedChildren('resolver') } }
          : {},
    },
    weightedMerkleSnapshot: {
      abi: merkleSnapshotAbi,
      startBlock: CORE_START_BLOCK,
      chain:
        WEIGHTED_FACTORIES.length > 0
          ? { [CORE_CHAIN]: { address: weightedChildren('snapshot') } }
          : {},
    },
    trustComposeFactory: {
      abi: trustComposeFactoryAbi,
      startBlock: CORE_START_BLOCK,
      chain:
        COMPOSITION_FACTORIES.length > 0
          ? { [CORE_CHAIN]: { address: COMPOSITION_FACTORIES } }
          : {},
    },
    trustComposeParamsController: {
      abi: trustComposeParamsControllerAbi,
      startBlock: CORE_START_BLOCK,
      chain:
        COMPOSITION_FACTORIES.length > 0
          ? { [CORE_CHAIN]: { address: compositionControllers() } }
          : {},
    },
    compositionAccumulator: {
      abi: compositionAccumulatorAbi,
      startBlock: CORE_START_BLOCK,
      chain:
        COMPOSITION_FACTORIES.length > 0
          ? {
              [CORE_CHAIN]: {
                address: compositionChildren('accumulator'),
              },
            }
          : {},
    },
    compositionMerkleSnapshot: {
      abi: merkleSnapshotAbi,
      startBlock: CORE_START_BLOCK,
      chain:
        COMPOSITION_FACTORIES.length > 0
          ? { [CORE_CHAIN]: { address: compositionChildren('snapshot') } }
          : {},
    },
    governedTrustgraphsFactory: {
      abi: governedTrustgraphsFactoryAbi,
      startBlock: CORE_START_BLOCK,
      chain:
        GOVERNED_TRUSTGRAPHS_FACTORIES.length > 0
          ? { [CORE_CHAIN]: { address: GOVERNED_TRUSTGRAPHS_FACTORIES } }
          : {},
    },
    // The weighted/compose governed wrappers, both generations of each. Same event surface as
    // the trust-graph wrapper by construction (`GovernedInstanceCreated` /
    // `GovernedAuthorityInstalled` are byte-identical signatures), so they reuse its ABI and
    // `governed.ts` registers ONE handler for all of them.
    governedWeightedTrustgraphsFactory: {
      abi: governedTrustgraphsFactoryAbi,
      startBlock: CORE_START_BLOCK,
      chain: GOVERNED_WEIGHTED_FACTORY
        ? {
            [CORE_CHAIN]: {
              address: [
                GOVERNED_WEIGHTED_FACTORY,
                GOVERNED_WEIGHTED_FACTORY_FAST,
              ].filter((address): address is Hex => address !== undefined),
            },
          }
        : {},
    },
    governedTrustComposeFactory: {
      abi: governedTrustgraphsFactoryAbi,
      startBlock: CORE_START_BLOCK,
      chain: GOVERNED_COMPOSE_FACTORY
        ? {
            [CORE_CHAIN]: {
              address: [
                GOVERNED_COMPOSE_FACTORY,
                GOVERNED_COMPOSE_FACTORY_FAST,
              ].filter((address): address is Hex => address !== undefined),
            },
          }
        : {},
    },
    signerSyncModuleDeployer: {
      abi: signerSyncModuleDeployerAbi,
      startBlock: CORE_START_BLOCK,
      chain: SIGNER_SYNC_DEPLOYER
        ? { [CORE_CHAIN]: { address: SIGNER_SYNC_DEPLOYER } }
        : {},
    },
    trustgraphsParamsController: {
      abi: trustgraphsParamsControllerAbi,
      startBlock: CORE_START_BLOCK,
      chain: FACTORY_DISCOVERY
        ? { [CORE_CHAIN]: { address: paramsControllers() } }
        : {},
    },
    migratedTrustgraphsParamsController: {
      abi: trustgraphsParamsControllerAbi,
      startBlock: CORE_START_BLOCK,
      chain: INSTANCE_REGISTRY
        ? { [CORE_CHAIN]: { address: migratedParamsControllers() } }
        : {},
    },
    contributionsParamsController: {
      abi: contributionsParamsControllerAbi,
      startBlock: CORE_START_BLOCK,
      chain: INSTANCE_REGISTRY
        ? { [CORE_CHAIN]: { address: migratedParamsControllers() } }
        : {},
    },
    easIndexerResolver: {
      abi: easIndexerResolverAbi,
      startBlock: CORE_START_BLOCK,
      chain: {
        [CORE_CHAIN]: {
          address: FACTORY_DISCOVERY
            ? instanceChildren('resolver')
            : deployedAddresses('easIndexerResolver'),
        },
      },
    },
    merkleSnapshot: {
      abi: merkleSnapshotAbi,
      startBlock: CORE_START_BLOCK,
      chain: {
        [CORE_CHAIN]: {
          address: FACTORY_DISCOVERY
            ? instanceChildren('snapshot')
            : deployedAddresses('merkleSnapshot'),
        },
      },
    },
    // The proving tank. Its events answer the two questions the vault panel asks — how much is
    // left, and who is being paid — neither of which is derivable from the snapshot alone.
    provingVault: {
      abi: provingVaultAbi,
      startBlock: CORE_START_BLOCK,
      chain: PROVING_VAULT ? { [CORE_CHAIN]: { address: PROVING_VAULT } } : {},
    },
    merkleFundDistributor: {
      abi: merkleFundDistributorAbi,
      startBlock: CORE_START_BLOCK,
      chain: FACTORY_DISCOVERY
        ? { [CORE_CHAIN]: { address: instanceChildren('distributor') } }
        : deploymentSummary.networks.some(
              (network) => network.contracts.merkleFundDistributor
            )
          ? {
              [CORE_CHAIN]: {
                address: deployedAddresses('merkleFundDistributor'),
              },
            }
          : {},
    },
    // The weighted / compose programs' creation-time fund distributors (the create paths
    // expose `withDistributor`), plus the funds attached to any instance later through
    // `attachDistributor`. Same ABI and the same merkle.ts handlers as `merkleFundDistributor`;
    // separate sources only because each parent factory event names the child differently.
    weightedMerkleFundDistributor: {
      abi: merkleFundDistributorAbi,
      startBlock: CORE_START_BLOCK,
      chain:
        WEIGHTED_FACTORIES.length > 0
          ? { [CORE_CHAIN]: { address: weightedChildren('distributor') } }
          : {},
    },
    compositionMerkleFundDistributor: {
      abi: merkleFundDistributorAbi,
      startBlock: CORE_START_BLOCK,
      chain:
        COMPOSITION_FACTORIES.length > 0
          ? { [CORE_CHAIN]: { address: compositionChildren('distributor') } }
          : {},
    },
    attachedMerkleFundDistributor: {
      abi: merkleFundDistributorAbi,
      startBlock: CORE_START_BLOCK,
      chain:
        BASE_FACTORIES.length > 0
          ? { [CORE_CHAIN]: { address: attachedDistributors() } }
          : {},
    },
    // The non-factory programs' snapshots (contributions, hypercerts). Same ABI and same handlers
    // as `merkleSnapshot` (src/merkle.ts, src/anchor.ts register both); a separate source only
    // because Ponder's `address` is either a static list or a factory, never both.
    programSnapshot: {
      abi: merkleSnapshotAbi,
      startBlock: DEV_START_BLOCK,
      chain:
        programSnapshots.length > 0
          ? { [CORE_CHAIN]: { address: programSnapshots } }
          : {},
    },
    // The non-factory programs' fund distributors (the contributions round's payout contract).
    // Backfills from DEV_START_BLOCK like everything else that is known up front — the `latest`
    // workaround the factory children used to need is gone, so a `Distributed` that predates the
    // indexer is now caught on replay rather than lost.
    programFundDistributor: {
      abi: merkleFundDistributorAbi,
      startBlock: DEV_START_BLOCK,
      chain:
        programFundDistributors.length > 0
          ? { [CORE_CHAIN]: { address: programFundDistributors } }
          : {},
    },
    // Lane-2 anchor registry. Discovered from deployment_summary.json under
    // `network.contracts.anchorRegistry` — single instance for now; only present once a lane-2
    // instance is deployed, so gate on its presence exactly like merkleGovModule/safe. Backfills like
    // merkleSnapshot (it emits HeadAnchored/NodeRegistered that may predate the indexer start).
    anchorRegistry: {
      abi: anchorRegistryAbi,
      startBlock: CORE_START_BLOCK,
      chain: deploymentSummary.networks.some(
        (network) => network.contracts.anchorRegistry
      )
        ? {
            [CORE_CHAIN]: {
              address: deploymentSummary.networks.flatMap(
                (network) => (network.contracts.anchorRegistry as Hex) || []
              ),
            },
          }
        : {},
    },
    // Opt-in strict v2 lane. Every registry comes only from the authenticated factory event; no
    // manifest, annotation, or deployment-summary address can create a strict lane row.
    easOffchainAnchorRegistry: {
      abi: easOffchainAnchorRegistryAbi,
      startBlock: CORE_START_BLOCK,
      chain: FACTORY_DISCOVERY
        ? { [CORE_CHAIN]: { address: easOffchainRegistries() } }
        : {},
    },
    // Contributions-program resolver + accumulator. Discovered from deployment_summary.json
    // under `network.contracts.contributionResolver` — only present once a contributions instance is
    // deployed, so gate on its presence exactly like anchorRegistry. Backfills like the EAS resolver
    // (attestations may predate the indexer start; the fold log must be complete for the derived
    // scoring recompute).
    contributionResolver: {
      abi: contributionResolverAbi,
      startBlock: CORE_START_BLOCK,
      chain: deploymentSummary.networks.some(
        (network) => network.contracts.contributionResolver
      )
        ? {
            [CORE_CHAIN]: {
              address: deploymentSummary.networks.flatMap(
                (network) =>
                  (network.contracts.contributionResolver as Hex) || []
              ),
            },
          }
        : {},
    },
    // The contributions ROUND factory (D3). When it is deployed, the chain is the contributions
    // catalog: every round's resolver / snapshot / distributor is discovered from
    // `ContributionsInstanceCreated` through the three factory() sources below, and the
    // `contributions_instance` table (src/contributions-factory.ts) replaces the build-time
    // CONTRIBUTIONS_INSTANCES import from deployment_summary.json.
    contributionsFactory: {
      abi: contributionsFactoryAbi,
      startBlock: CORE_START_BLOCK,
      chain:
        CONTRIBUTIONS_FACTORIES.length > 0
          ? { [CORE_CHAIN]: { address: CONTRIBUTIONS_FACTORIES } }
          : {},
    },
    // Factory-discovered round children. Same ABIs and same handlers as their static siblings
    // above (`contributionResolver`, `programSnapshot`, `programFundDistributor`) — separate
    // sources only because Ponder's `address` is either a static list or a factory, never both.
    factoryContributionResolver: {
      abi: contributionResolverAbi,
      startBlock: CORE_START_BLOCK,
      chain:
        CONTRIBUTIONS_FACTORIES.length > 0
          ? { [CORE_CHAIN]: { address: contributionsChildren('resolver') } }
          : {},
    },
    contributionsMerkleSnapshot: {
      abi: merkleSnapshotAbi,
      startBlock: CORE_START_BLOCK,
      chain:
        CONTRIBUTIONS_FACTORIES.length > 0
          ? { [CORE_CHAIN]: { address: contributionsChildren('snapshot') } }
          : {},
    },
    contributionsFundDistributor: {
      abi: merkleFundDistributorAbi,
      startBlock: CORE_START_BLOCK,
      chain:
        CONTRIBUTIONS_FACTORIES.length > 0
          ? { [CORE_CHAIN]: { address: contributionsChildren('distributor') } }
          : {},
    },
    merkleGovModule: {
      abi: merkleGovModuleAbi,
      startBlock: 'latest',
      chain: deploymentSummary.networks.some(
        (network) => network.contracts.merkleGovModule
      )
        ? {
            [CORE_CHAIN]: {
              address: deploymentSummary.networks.flatMap(
                (network) => (network.contracts.merkleGovModule as Hex) || []
              ),
            },
          }
        : {},
    },
    governedMerkleGovModule: {
      abi: merkleGovModuleAbi,
      startBlock: CORE_START_BLOCK,
      chain:
        GOVERNED_WRAPPERS.length > 0
          ? {
              [CORE_CHAIN]: {
                address: governedChildren('merkleGovModule'),
              },
            }
          : {},
    },
    governedSignerSyncModule: {
      abi: signerSyncZkModuleAbi,
      startBlock: CORE_START_BLOCK,
      chain: SIGNER_SYNC_DEPLOYER
        ? {
            [CORE_CHAIN]: {
              address: governedSignerModules(),
            },
          }
        : {},
    },
    gnosisSafe: {
      abi: gnosisSafeAbi,
      startBlock: 'latest',
      chain: deploymentSummary.networks.some(
        (network) => network.contracts.safe?.proxy
      )
        ? {
            [CORE_CHAIN]: {
              address: deploymentSummary.networks.flatMap(
                (network) => (network.contracts.safe?.proxy as Hex) || []
              ),
            },
          }
        : {},
    },
    governedGnosisSafe: {
      abi: gnosisSafeAbi,
      startBlock: CORE_START_BLOCK,
      chain:
        GOVERNED_WRAPPERS.length > 0
          ? {
              [CORE_CHAIN]: {
                address: governedChildren('safe'),
              },
            }
          : {},
    },
  },
})
