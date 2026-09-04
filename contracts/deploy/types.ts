import { DotenvParseOutput } from 'dotenv'
import { Hex } from 'viem'

export type ContractDeployment = {
  name: string
  script: string
  sig: string
  args: (ctx: ProgramContext) => Array<string | number | boolean>
  env?: (ctx: ProgramContext) => Record<string, string>
  skip?: (ctx: ProgramContext) => boolean | Promise<boolean>
  postRun?: (ctx: ProgramContext) => void | Promise<void>
}

export type EnvName = 'dev' | 'prod'
export type DeploymentStage = 'development' | 'production'
export type ChainTarget = 'local' | 'sepolia' | 'mainnet'

export type ChainProfile = {
  target: ChainTarget
  name: string
  chainId: number
  public: boolean
  rpcEnv: string
  wsEnv: string
  startBlockEnv: string
  explorer?: string
  releaseManifestFile?: string
}

export type IEnv = {
  stage: DeploymentStage
  profile: ChainProfile
  rpcUrl: string
  registry: string
  serviceName: string
  triggerChain: string
  submitChain: string
  ipfs: {
    pinApi: string
    gateway: string
  }
  networksConfigFile: string
  deployContracts: ContractDeployment[]
  postDeployContracts?: () => void | Promise<void>
  validateDeployment?: () => void | Promise<void>
  uploadToIpfs: (file: string, apiKey?: string) => Promise<string>
  generateDeploymentSummary: () => object
  generateReleaseManifest?: (ctx?: ProgramContext) => object
}

export type EnvOverrides = {
  rpcUrl?: string
  ipfsGateway?: string
  stage?: DeploymentStage
  target?: ChainTarget
}

export type ProgramContext = {
  /** Legacy environment alias retained for existing local tooling. */
  envName: EnvName
  stage: DeploymentStage
  target: ChainTarget
  /** The environment context */
  env: IEnv
  /** Passed in options */
  options: Record<string, any>
  /** The environment variables loaded from the .env file */
  dotenv: DotenvParseOutput
}

export type NetworkDeploy = {
  deployer: Hex
  /** Optional: factory-derived deploy files omit it. */
  epoch_length?: number
  contracts: {
    merkle_snapshot: Hex
    eas_indexer_resolver: Hex
    fund_distributor?: Hex
    params_controller?: Hex
  }
  schemas: {
    [key: string]:
      | {
          uid: Hex
          key: string
          name: string
          description: string
          resolver: Hex
          revocable: boolean
          schema: string
        }
      // Used as placeholder for forge serialization.
      | '_'
  }
}

/** One registered schema as serialized by the deploy scripts. */
export type DeployedSchema = {
  uid: Hex
  key: string
  name: string
  description: string
  resolver: Hex
  revocable: boolean
  schema: string
}

export type SafeZodiacSignerSyncDeploy = {
  safe_factory: Hex
  safe_singleton: Hex
  safe_proxy: Hex
  signer_sync_manager: Hex
}

/** Shape written by `contracts/script/DeployZodiacSafes.s.sol` to `.docker/zodiac_safes_deploy.json`. */
export type ZodiacSafesDeploy = {
  safe_singleton: Hex
  safe_factory: Hex
  safe: {
    address: Hex
    merkle_gov_module: Hex
    signer_sync_module: Hex
  }
}

export type Network = {
  id: string
  name: string
  link?: {
    prefix: string
    label: string
    href: string
  }
  about: string
  callToAction?: {
    label: string
    href: string
  }
  criteria: string
  contracts: {
    merkleSnapshot: Hex
    easIndexerResolver: Hex
    merkleFundDistributor?: Hex
    merkleGovModule?: Hex
    safe?: {
      factory: Hex
      singleton: Hex
      proxy: Hex
      signerSyncManager: Hex
    }
  }
  schemas: NetworkSchema[]
  pagerank: {
    enabled: boolean
    pointsPool: number
    trustShare: number
    trustDecay: number
    minWeight: number
    maxWeight: number
    trustedSeeds: Hex[]
  }
  safeZodiacSignerSync: {
    enabled: boolean
    topNSigners: number
    minThreshold: number
    targetThreshold: number
  }
  validatedThreshold: number
}

export type NetworkSchema = {
  uid: Hex
  key: string
  name: string
  description: string
  resolver: Hex
  revocable: boolean
  schema: string
  fields: { name: string; type: string }[]
}
