import { ChainProfile, ChainTarget, DeploymentStage, EnvName } from './types'

export const CHAIN_PROFILES: Record<ChainTarget, ChainProfile> = {
  local: {
    target: 'local',
    name: 'Local Anvil',
    chainId: 31337,
    public: false,
    rpcEnv: 'RPC_URL',
    wsEnv: 'PONDER_WS_URL_31337',
    startBlockEnv: 'PONDER_START_BLOCK',
  },
  optimism: {
    target: 'optimism',
    name: 'Optimism (legacy)',
    chainId: 10,
    public: true,
    rpcEnv: 'PONDER_RPC_URL_10',
    wsEnv: 'PONDER_WS_URL_10',
    startBlockEnv: 'PONDER_START_BLOCK_10',
    explorer: 'https://optimistic.etherscan.io',
  },
  sepolia: {
    target: 'sepolia',
    name: 'Ethereum Sepolia',
    chainId: 11155111,
    public: true,
    rpcEnv: 'PONDER_RPC_URL_11155111',
    wsEnv: 'PONDER_WS_URL_11155111',
    startBlockEnv: 'PONDER_START_BLOCK_11155111',
    explorer: 'https://sepolia.etherscan.io',
    releaseManifestFile: 'deployments/sepolia.json',
  },
  mainnet: {
    target: 'mainnet',
    name: 'Ethereum Mainnet',
    chainId: 1,
    public: true,
    rpcEnv: 'PONDER_RPC_URL_1',
    wsEnv: 'PONDER_WS_URL_1',
    startBlockEnv: 'PONDER_START_BLOCK_1',
    explorer: 'https://etherscan.io',
  },
}

const normalizeStage = (value?: string): DeploymentStage | undefined => {
  if (!value) return undefined
  switch (value.toLowerCase()) {
    case 'dev':
    case 'development':
      return 'development'
    case 'prod':
    case 'production':
      return 'production'
    default:
      throw new Error(`Invalid deployment stage: ${value}`)
  }
}

const normalizeTarget = (value?: string): ChainTarget | undefined => {
  if (!value) return undefined
  const target = value.toLowerCase()
  if (!(target in CHAIN_PROFILES)) {
    throw new Error(`Invalid chain target: ${value}`)
  }
  return target as ChainTarget
}

export type DeploymentSelection = {
  stage: DeploymentStage
  target: ChainTarget
  envName: EnvName
  profile: ChainProfile
}

/**
 * Resolve deployment strictness independently from chain identity.
 *
 * Stage decides how strict validation is; target decides which chain. Naming
 * neither is the local development default; naming a public target without a
 * stage implies production.
 */
export const resolveDeploymentSelection = ({
  stage,
  target,
}: {
  stage?: string
  target?: string
}): DeploymentSelection => {
  let resolvedStage = normalizeStage(stage)
  let resolvedTarget = normalizeTarget(target)

  if (!resolvedStage && resolvedTarget) {
    resolvedStage = resolvedTarget === 'local' ? 'development' : 'production'
  }
  if (!resolvedStage) resolvedStage = 'development'
  if (!resolvedTarget) {
    if (resolvedStage === 'production') {
      throw new Error(
        'Production deployment requires an explicit chain target (--chain or DEPLOY_TARGET)'
      )
    }
    resolvedTarget = 'local'
  }

  if (resolvedStage === 'development' && resolvedTarget !== 'local') {
    throw new Error(
      `Development stage cannot target public chain ${resolvedTarget}`
    )
  }
  if (resolvedStage === 'production' && resolvedTarget === 'local') {
    throw new Error('Production stage cannot target local Anvil')
  }

  return {
    stage: resolvedStage,
    target: resolvedTarget,
    envName: resolvedStage === 'development' ? 'dev' : 'prod',
    profile: CHAIN_PROFILES[resolvedTarget],
  }
}
