import { DotenvParseOutput } from 'dotenv'
import { Hex } from 'viem'

export type ContractDeployment = {
  name: string
  script: string
  sig: string
  args: (ctx: ProgramContext) => string[]
  skip?: (ctx: ProgramContext) => boolean | Promise<boolean>
  postRun?: (ctx: ProgramContext) => void | Promise<void>
}

export type EnvName = 'dev' | 'prod'

export type IEnv = {
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
  uploadToIpfs: (file: string, apiKey?: string) => Promise<string>
  generateDeploymentSummary: () => object
}

export type EnvOverrides = {
  rpcUrl?: string
  ipfsGateway?: string
}

export type ProgramContext = {
  /** The environment name */
  envName: EnvName
  /** The environment context */
  env: IEnv
  /** Passed in options */
  options: Record<string, any>
  /** The environment variables loaded from the .env file */
  dotenv: DotenvParseOutput
}

export type NetworkDeploy = {
  deployer: Hex
  /** Present on direct DeployNetwork artifacts; older and factory-derived files omit it. */
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

/**
 * Shape written by `contracts/script/DeployContributionsInstance.s.sol` to
 * `.docker/contributions_instance_<label>_deploy.json`.
 */
export type ContributionsInstanceDeploy = {
  deployer: Hex
  instance_id: Hex
  params_hash: Hex
  epoch_length: number
  contracts: {
    contribution_resolver: Hex
    trust_accumulator_mirror: Hex
    trust_accumulator: Hex
    sp1_gateway: Hex
    zk_verifier: Hex
    merkle_snapshot: Hex
    params_controller: Hex
    instance_registry: Hex
    fund_distributor: Hex
    pool_token: Hex
  }
  schemas: {
    claim: DeployedSchema
    response: DeployedSchema
    valuation: DeployedSchema
  }
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
