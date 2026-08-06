import path from 'path'

import dotenv from 'dotenv'
import { createConfig, factory } from 'ponder'
import { Hex, getAbiItem } from 'viem'

import deploymentSummaryJson from '../.docker/deployment_summary.json'
import { anchorRegistryAbi } from './abis/anchorRegistry'
import { provingVaultAbi } from './abis/provingVault'
import { trustGraphFactoryAbi } from './abis/trustGraphFactory'
import {
  contributionResolverAbi,
  easIndexerResolverAbi,
  gnosisSafeAbi,
  merkleFundDistributorAbi,
  merkleGovModuleAbi,
  merkleSnapshotAbi,
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

const TRUST_GRAPH_FACTORY = deploymentSummary.factory?.factory as
  | Hex
  | undefined

/**
 * Whether to discover trust-graph children from the factory. Production (Optimism) predates the
 * factory — its instances were stood up by `DeployNetwork.s.sol` and stay statically configured
 * until the factory is deployed there; likewise a dev box whose deploy chain never ran
 * `DeployFactory` (a lane-2-only hypercerts box) falls back to the static lists.
 */
const FACTORY_DISCOVERY = !IS_PRODUCTION && TRUST_GRAPH_FACTORY !== undefined

/** The frozen discovery event. Every child address below is one of its arguments. */
const INSTANCE_CREATED = getAbiItem({
  abi: trustGraphFactoryAbi,
  name: 'InstanceCreated',
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
    address: TRUST_GRAPH_FACTORY!,
    event: INSTANCE_CREATED,
    parameter,
    startBlock: DEV_START_BLOCK,
  })

/** Is this summary entry a trust-graph (vouching) network? Absent `program` means yes. */
const isTrustGraph = (network: DeployedNetwork) =>
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
const otherProgram = (network: DeployedNetwork) => !isTrustGraph(network)
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
    // The instance directory itself: `InstanceCreated` is both the catalog row (src/factory.ts →
    // the `instance` table, which replaces config/networks.json for trust-graph networks) and the
    // address source for the three child contracts below.
    trustGraphFactory: {
      abi: trustGraphFactoryAbi,
      startBlock: DEV_START_BLOCK,
      chain: FACTORY_DISCOVERY
        ? { [CORE_CHAIN]: { address: TRUST_GRAPH_FACTORY! } }
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
  },
})
