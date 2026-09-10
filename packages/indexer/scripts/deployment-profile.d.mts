export type DeploymentStage = 'development' | 'production'
export type DeploymentTarget = 'local' | 'sepolia' | 'mainnet'
export type PublicDeploymentTarget = Exclude<DeploymentTarget, 'local'>

export interface ChainProfile {
  target: DeploymentTarget
  name: string
  chainId: number
  public: boolean
  rpcEnv: string
  wsEnv: string
  startBlockEnv: string
  /** Repository-relative; present on public targets only. */
  releaseManifestFile?: string
  /** Repository-relative networks catalog linked to `packages/indexer/networks.json`. */
  networksFile: string
}

export const CHAIN_PROFILES: Readonly<Record<DeploymentTarget, ChainProfile>>
export const DEPLOY_TARGETS: readonly DeploymentTarget[]
export function chainProfile(target: string): ChainProfile

export interface FinalizedReleaseManifest {
  version: 1
  status: 'deployed'
  stage: 'production'
  chain: PublicDeploymentTarget
  chainId: number
  deploymentCommit: string
  firstDeploymentBlock: number
  [key: string]: unknown
}

export function manifestContractAddresses(
  manifest: object,
  chainName?: string
): string[]

export function loadFinalizedManifest(
  target: string,
  repoDir: string
): { file: string; manifest: FinalizedReleaseManifest; profile: ChainProfile }

interface ResolvedProfileBase {
  stage: DeploymentStage
  target: DeploymentTarget
  production: boolean
  chainId: number
  chainName: string
  rpcEnv: string
  wsEnv: string
  startBlockEnv: string
  /** Absolute path of the networks catalog for this target. */
  networksFile: string
  defaultStartBlock: number
  /** Absolute path of the deployment record (release manifest or local deployment summary). */
  deploymentFile: string
}

export interface LocalDeploymentProfile extends ResolvedProfileBase {
  stage: 'development'
  target: 'local'
  production: false
  requiredCodeAddresses?: undefined
}

export interface PublicDeploymentProfile extends ResolvedProfileBase {
  stage: 'production'
  target: PublicDeploymentTarget
  production: true
  requiredCodeAddresses: string[]
}

export type DeploymentProfile = LocalDeploymentProfile | PublicDeploymentProfile

export function resolveDeploymentProfile(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  repoDir: string
): DeploymentProfile
