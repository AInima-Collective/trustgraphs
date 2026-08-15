import path from 'path'

import dotenv from 'dotenv'
import { createConfig, factory } from 'ponder'
import { Hex, getAbiItem } from 'viem'

import deploymentSummaryJson from '../.docker/deployment_summary.json'
import { anchorRegistryAbi } from './abis/anchorRegistry'
import {
  compositionAccumulatorAbi,
  trustComposeFactoryAbi,
  trustComposeParamsControllerAbi,
} from './abis/composition'
import { contributionsParamsControllerAbi } from './abis/contributionsParamsController'
import {
  OPTIMISM_ERC8004_IDENTITY_REGISTRY,
  erc8004IdentityRegistryAbi,
} from './abis/erc8004IdentityRegistry'
import {
  OPTIMISM_ERC8004_REPUTATION_REGISTRY,
  erc8004ReputationRegistryAbi,
} from './abis/erc8004ReputationRegistry'
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
const deploymentSummary = deploymentSummaryJson as {
  networks: DeployedNetwork[]
  /** `.docker/factory_deploy.json`, present once `DeployFactory` has run on this box. */
  factory?: { factory?: string; instance_registry?: string }
  governedFactory?: {
    governed_factory?: string
    signer_sync_deployer?: string
  }
  weightedFactory?: { weighted_factory?: string }
  compositionFactory?: { composition_factory?: string }
}

const dotenvFile = path.join(__dirname, '../.env')
dotenv.config({
  path: dotenvFile,
  quiet: true,
})

const { DEPLOY_ENV } = process.env
if (!DEPLOY_ENV) {
  throw new Error(`Failed to load DEPLOY_ENV from ${dotenvFile}`)
}

export const IS_PRODUCTION = DEPLOY_ENV.toUpperCase().trim() === 'PROD'
const CORE_CHAIN = IS_PRODUCTION ? 'optimism' : 'local'

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

// Earliest production deployment in the current Optimism catalog. Every source without a more
// precise known block starts here, never at genesis. Operators can move the common floor forward
// when deploying a fresh catalog, but it must remain at or before every configured contract.
const PROD_START_BLOCK = blockNumberEnv('PONDER_START_BLOCK_10', 142_786_328)
const CORE_START_BLOCK = IS_PRODUCTION ? PROD_START_BLOCK : DEV_START_BLOCK

/**
 * ERC-8004 is deliberately allowlisted: production always follows the official Optimism
 * singleton, while development accepts only an explicit local-fixture address. An arbitrary
 * production address cannot be smuggled in through configuration.
 */
const ERC8004_IDENTITY_REGISTRY = IS_PRODUCTION
  ? (OPTIMISM_ERC8004_IDENTITY_REGISTRY.proxy as Hex)
  : (process.env.ERC8004_IDENTITY_REGISTRY_ADDRESS_31337 as Hex | undefined)
const ERC8004_START_BLOCK = IS_PRODUCTION
  ? OPTIMISM_ERC8004_IDENTITY_REGISTRY.sourceBlock
  : DEV_START_BLOCK
const ERC8004_REPUTATION_REGISTRY = IS_PRODUCTION
  ? (OPTIMISM_ERC8004_REPUTATION_REGISTRY.proxy as Hex)
  : (process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS_31337 as Hex | undefined)
const ERC8004_REPUTATION_START_BLOCK = IS_PRODUCTION
  ? OPTIMISM_ERC8004_REPUTATION_REGISTRY.sourceBlock
  : DEV_START_BLOCK
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
const GOVERNED_FACTORY = deploymentSummary.governedFactory?.governed_factory as
  | Hex
  | undefined
const SIGNER_SYNC_DEPLOYER = deploymentSummary.governedFactory
  ?.signer_sync_deployer as Hex | undefined
const WEIGHTED_FACTORY =
  ((IS_PRODUCTION
    ? process.env.WEIGHTED_FACTORY_ADDRESS_10
    : process.env.WEIGHTED_FACTORY_ADDRESS_31337
  )?.trim() as Hex | undefined) ??
  (deploymentSummary.weightedFactory?.weighted_factory as Hex | undefined)
const COMPOSITION_FACTORY =
  ((IS_PRODUCTION
    ? process.env.TRUST_COMPOSE_FACTORY_ADDRESS_10
    : process.env.TRUST_COMPOSE_FACTORY_ADDRESS_31337
  )?.trim() as Hex | undefined) ??
  (deploymentSummary.compositionFactory?.composition_factory as Hex | undefined)

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

/**
 * A `factory()` address source for one of `InstanceCreated`'s child-contract arguments. Children
 * are indexed from their creation block, so nothing here needs a start block of its own.
 *
 * `distributor` is `address(0)` for an instance created without one; a zero address simply never
 * matches a log, so no special-casing is needed.
 */
const instanceChildren = (parameter: 'snapshot' | 'resolver' | 'distributor') =>
  factory({
    address: TRUSTGRAPHS_FACTORY!,
    event: INSTANCE_CREATED,
    parameter,
    startBlock: CORE_START_BLOCK,
  })

const paramsControllers = () =>
  factory({
    address: TRUSTGRAPHS_FACTORY!,
    event: PARAMS_CONTROLLER_CREATED,
    parameter: 'controller',
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
    address: GOVERNED_FACTORY!,
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
    address: WEIGHTED_FACTORY!,
    event: WEIGHTED_PARAMS_CONTROLLER_CREATED,
    parameter: 'controller',
    startBlock: CORE_START_BLOCK,
  })

const weightedChildren = (parameter: 'snapshot' | 'resolver' | 'distributor') =>
  factory({
    address: WEIGHTED_FACTORY!,
    event: WEIGHTED_INSTANCE_CREATED,
    parameter,
    startBlock: CORE_START_BLOCK,
  })

const compositionControllers = () =>
  factory({
    address: COMPOSITION_FACTORY!,
    event: COMPOSITION_CONTROLLER_CREATED,
    parameter: 'controller',
    startBlock: CORE_START_BLOCK,
  })

const compositionChildren = (parameter: 'snapshot' | 'accumulator') =>
  factory({
    address: COMPOSITION_FACTORY!,
    event: COMPOSITION_INSTANCE_CREATED,
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
          optimism: {
            id: 10,
            rpc: requiredEnv('PONDER_RPC_URL_10'),
            ...(process.env.PONDER_WS_URL_10
              ? { ws: process.env.PONDER_WS_URL_10 }
              : {}),
          },
        }),
  },
  contracts: {
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
        ? { [CORE_CHAIN]: { address: TRUSTGRAPHS_FACTORY! } }
        : {},
    },
    weightedTrustgraphsFactory: {
      abi: weightedTrustgraphsFactoryAbi,
      startBlock: CORE_START_BLOCK,
      chain: WEIGHTED_FACTORY
        ? { [CORE_CHAIN]: { address: WEIGHTED_FACTORY } }
        : {},
    },
    weightedPriorParamsController: {
      abi: weightedPriorParamsControllerAbi,
      startBlock: CORE_START_BLOCK,
      chain: WEIGHTED_FACTORY
        ? { [CORE_CHAIN]: { address: weightedParamsControllers() } }
        : {},
    },
    weightedEasIndexerResolver: {
      abi: easIndexerResolverAbi,
      startBlock: CORE_START_BLOCK,
      chain: WEIGHTED_FACTORY
        ? { [CORE_CHAIN]: { address: weightedChildren('resolver') } }
        : {},
    },
    weightedMerkleSnapshot: {
      abi: merkleSnapshotAbi,
      startBlock: CORE_START_BLOCK,
      chain: WEIGHTED_FACTORY
        ? { [CORE_CHAIN]: { address: weightedChildren('snapshot') } }
        : {},
    },
    trustComposeFactory: {
      abi: trustComposeFactoryAbi,
      startBlock: CORE_START_BLOCK,
      chain: COMPOSITION_FACTORY
        ? { [CORE_CHAIN]: { address: COMPOSITION_FACTORY } }
        : {},
    },
    trustComposeParamsController: {
      abi: trustComposeParamsControllerAbi,
      startBlock: CORE_START_BLOCK,
      chain: COMPOSITION_FACTORY
        ? { [CORE_CHAIN]: { address: compositionControllers() } }
        : {},
    },
    compositionAccumulator: {
      abi: compositionAccumulatorAbi,
      startBlock: CORE_START_BLOCK,
      chain: COMPOSITION_FACTORY
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
      chain: COMPOSITION_FACTORY
        ? { [CORE_CHAIN]: { address: compositionChildren('snapshot') } }
        : {},
    },
    governedTrustgraphsFactory: {
      abi: governedTrustgraphsFactoryAbi,
      startBlock: CORE_START_BLOCK,
      chain: GOVERNED_FACTORY
        ? { [CORE_CHAIN]: { address: GOVERNED_FACTORY } }
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
      startBlock: IS_PRODUCTION ? 142786483 : DEV_START_BLOCK,
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
      startBlock: IS_PRODUCTION ? 142786328 : DEV_START_BLOCK,
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
    // Lane-2 anchor registry (M2). Discovered from deployment_summary.json under
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
    // Contributions-program resolver + accumulator (M3). Discovered from deployment_summary.json
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
    merkleGovModule: {
      abi: merkleGovModuleAbi,
      startBlock: IS_PRODUCTION ? PROD_START_BLOCK : 'latest',
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
      chain: GOVERNED_FACTORY
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
      startBlock: IS_PRODUCTION ? 146706138 : 'latest',
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
      chain: GOVERNED_FACTORY
        ? {
            [CORE_CHAIN]: {
              address: governedChildren('safe'),
            },
          }
        : {},
    },
  },
})
