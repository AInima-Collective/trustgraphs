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
  contracts: {
    merkle_snapshot: Hex
    eas_indexer_resolver: Hex
    fund_distributor?: Hex
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

export type SafeZodiacSignerSyncDeploy = {
  safe_factory: Hex
  safe_singleton: Hex
  safe_proxy: Hex
  signer_sync_manager: Hex
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
    trustMultiplier: number
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
