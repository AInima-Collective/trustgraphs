import type { ChainTarget } from './types'

/** A public chain the release tooling can deploy to: every target but local Anvil. */
export type PublicChainTarget = Exclude<ChainTarget, 'local'>

/**
 * What differs between public chains beyond the profile row: which optional contract families the
 * first generation ships, which policy defaults hold, and how the chain opts into a fast epoch
 * floor. Adding a chain is adding a row here and in `CHAIN_PROFILES`; nothing else in the deploy
 * tooling may spell a chain name.
 */
export type PublicChainPlan = {
  /**
   * Deploy the imported-EAS ("start from existing attestations") factory pair. It drives a
   * canonical-EAS crawl in the indexer and its completeness guarantee is a recorded open
   * decision, so a first generation may leave it out and add it later with `--continue-existing`.
   */
  importedEasFamily: boolean
  /**
   * Default `FEED_MAX_STALENESS` for the proving vault, in seconds. Chainlink's ETH/USD feed
   * heartbeats hourly on mainnet (the script default of 5400 s is heartbeat plus 50%); Sepolia's
   * feed is slower and less regular, measured at a 3696 s worst gap on 2026-08-23.
   */
  feedMaxStaleness: string
  /**
   * The environment variable that opts this chain into a factory epoch floor below the ~1-day
   * `DELIBERATE_EPOCH_FLOOR` in `contracts/script/Common.s.sol`. Spelled per chain so a testnet
   * overlay copied to mainnet carries no opt-in with it.
   */
  epochFloorOptIn: string
}

export const DELIBERATE_EPOCH_FLOOR = 7200n

export const PUBLIC_CHAIN_PLANS: Record<PublicChainTarget, PublicChainPlan> = {
  sepolia: {
    importedEasFamily: true,
    feedMaxStaleness: '7200',
    epochFloorOptIn: 'ALLOW_TESTNET_EPOCH_FLOOR',
  },
  mainnet: {
    importedEasFamily: false,
    feedMaxStaleness: '5400',
    epochFloorOptIn: 'ALLOW_MAINNET_EPOCH_FLOOR',
  },
}

export const isPublicChainTarget = (
  target: string
): target is PublicChainTarget => target in PUBLIC_CHAIN_PLANS

/** The contract records a complete generation must carry on the given chain, in plan order. */
export const hostedFamilyKeys = (target: PublicChainTarget) => {
  const plan = PUBLIC_CHAIN_PLANS[target]
  return [
    'schemaRegistrar',
    'rootVerifier',
    'instanceRegistry',
    'provingVault',
    'trustgraphsFactory',
    ...(plan.importedEasFamily ? (['importedTrustgraphsFactory'] as const) : []),
    'signerVerifier',
    'governedTrustgraphsFactory',
    ...(plan.importedEasFamily
      ? (['governedImportedTrustgraphsFactory'] as const)
      : []),
    'signerSyncModuleDeployer',
    'parentAuthorityModuleDeployer',
    'subnetworkRegistry',
    'weightedVerifier',
    'weightedTrustgraphsFactory',
    'governedWeightedTrustgraphsFactory',
    'compositionVerifier',
    'trustComposeFactory',
    'governedTrustComposeFactory',
    'contributionsVerifier',
    'contributionsFactory',
  ] as const
}
