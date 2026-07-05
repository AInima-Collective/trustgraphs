import fs from 'fs'
import path from 'path'

import { Command } from 'commander'

import {
  ContractDeployment,
  EnvName,
  EnvOverrides,
  IEnv,
  Network,
  NetworkDeploy,
  ProgramContext,
  SafeZodiacSignerSyncDeploy,
} from './types'
import {
  isNetworkComplete,
  isNetworkSafeZodiacSignerSyncDisabledOrComplete,
  loadDotenv,
  readJson,
  readJsonIfFileExists,
  readJsonKey,
  readJsonKeyIfFileExists,
} from './utils'

/** Placeholder address used when no SP1 gateway is configured (local/dev scaffolding). */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
/** Placeholder bytes32 used for an unset paramsHash / program vkey (local/dev scaffolding). */
const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000'

/**
 * Read a REQUIRED bytes32 env var for a production deployment; fail closed (throw) if it is unset
 * or zero. A zero `paramsHash`/vkey would deploy a MerkleSnapshot no valid proof could ever satisfy,
 * so prod must never fall back to the dev placeholder.
 */
function requireProdBytes32(name: string): string {
  const v = process.env[name]
  if (!v || v === ZERO_BYTES32 || /^0x0{64}$/i.test(v)) {
    const how = name === 'PARAMS_HASH' ? 'paramshash' : 'vkey'
    throw new Error(
      `${name} must be set to the real guest-computed value for a production deployment ` +
        `(got ${v ?? 'unset'}). Compute it with: cargo run -p trustgraph-prover -- ${how}`
    )
  }
  return v
}

type NonFunctionPropertyNames<T> = {
  [K in keyof T]: T[K] extends Function ? never : K
}[keyof T]

type OmitFunctions<T> = Pick<T, NonFunctionPropertyNames<T>>

abstract class EnvBase implements IEnv {
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

  constructor(options: OmitFunctions<IEnv>) {
    this.rpcUrl = options.rpcUrl
    this.registry = options.registry
    this.serviceName = options.serviceName
    this.triggerChain = options.triggerChain
    this.submitChain = options.submitChain
    this.ipfs = options.ipfs
    this.networksConfigFile = options.networksConfigFile
    this.deployContracts = options.deployContracts
    this.postDeployContracts = options.postDeployContracts
  }

  static get(envName: EnvName | string, overrides: EnvOverrides = {}): IEnv {
    switch (envName.toLowerCase()) {
      case 'dev':
        return new DevEnv(overrides)
      case 'prod':
        return new ProdEnv(overrides)
    }

    throw new Error(`Invalid environment: ${envName}`)
  }

  /**
   * Uploads a file to IPFS and returns the CID.
   *
   * @param file - The file to upload to IPFS
   * @returns The CID of the uploaded file
   */
  abstract uploadToIpfs(file: string, apiKey?: string): Promise<string>

  /**
   * Query IPFS for a CID and return the content.
   *
   * @param uriOrCid - The URI or CID to query
   * @returns The content of the file as a string
   */
  async queryIpfs(uriOrCid: string): Promise<string> {
    const cid = uriOrCid.replace('ipfs://', '')
    const response = await fetch(this.ipfs.gateway + cid)

    if (!response.ok) {
      throw new Error(
        `Failed to query IPFS: ${response.status} ${response.statusText}. Body: ${await response.text().catch(() => '<unable to read body>')}`
      )
    }

    return response.text()
  }

  /**
   * Generate deployment summary file.
   */
  generateDeploymentSummary(): object {
    return {
      service_id: '',
      rpc_url: this.rpcUrl,
      eas: readJsonIfFileExists('.docker/eas_deploy.json'),
      networks: readJsonIfFileExists(this.networksConfigFile),
      zodiac_safes: readJsonIfFileExists('.docker/zodiac_safes_deploy.json'),
    }
  }

  /**
   * Update networks config file with deployed contracts and schemas from
   * network_deploy_*.json files.
   *
   * If env is `dev`, contracts, schemas, and trusted seeds will be updated.
   *
   * If env is `prod`, contracts and schemas will be set if missing. Trusted seeds will not be touched.
   *
   * @param env - The environment to use for updating the networks config file.
   */
  updateNetworksConfigWithDeployments = (env: 'dev' | 'prod'): void => {
    // Read existing networks config or initialize empty array
    let networks: Network[] = []
    if (fs.existsSync(this.networksConfigFile)) {
      networks = readJson(this.networksConfigFile)
    }

    // Find all network_deploy_ENV_*.json files
    const deployFilesRegex = new RegExp(`^network_deploy_${env}_(\\d+)\.json$`)
    const deployFiles = fs
      .readdirSync('config')
      .filter((file) => file.match(deployFilesRegex))
      .sort()

    for (const deployFile of deployFiles) {
      // Extract index from filename (e.g., "network_deploy_dev_0.json" -> 0)
      const match = deployFile.match(deployFilesRegex)
      if (!match) {
        continue
      }
      const index = parseInt(match[1], 10)

      if (networks.length <= index) {
        throw new Error(
          `Cannot update network at index ${index} because there are only ${networks.length.toLocaleString()} networks configured.`
        )
      }

      const deployData = readJson<NetworkDeploy>(
        path.join('config', deployFile)
      )
      const safeZodiacSignerSyncDeployData =
        readJsonIfFileExists<SafeZodiacSignerSyncDeploy>(
          path.join(
            'config',
            `safe_zodiac_signer_sync_deploy_${env}_${index}.json`
          )
        )

      const network: Network = {
        ...networks[index],
        contracts: {
          merkleSnapshot: deployData.contracts.merkle_snapshot,
          easIndexerResolver: deployData.contracts.eas_indexer_resolver,
          merkleFundDistributor: deployData.contracts.fund_distributor,
          safe: safeZodiacSignerSyncDeployData && {
            factory: safeZodiacSignerSyncDeployData.safe_factory,
            singleton: safeZodiacSignerSyncDeployData.safe_singleton,
            proxy: safeZodiacSignerSyncDeployData.safe_proxy,
            signerSyncManager:
              safeZodiacSignerSyncDeployData.signer_sync_manager,
          },
        },
        schemas: Object.values(deployData.schemas).flatMap((data) => {
          // Ignore placeholder "_" key from forge serialization.
          if (data === '_') {
            return []
          }

          const fields = data.schema.split(',').map((field) => {
            const [type, name] = field.split(' ')
            return {
              name,
              type,
            }
          })

          return {
            ...data,
            fields,
          }
        }),
      }

      const networkToUpdate = networks[index]

      if (env === 'dev') {
        // Replace contracts, schemas, and trusted seeds for development.
        networkToUpdate.contracts = network.contracts
        networkToUpdate.schemas = network.schemas
        networkToUpdate.pagerank.trustedSeeds = [deployData.deployer]
      } else if (env === 'prod') {
        // Add or update missing contracts and schemas for production.
        Object.entries(network.contracts).forEach(([key, value]) => {
          if (!networkToUpdate.contracts[key as keyof Network['contracts']]) {
            networkToUpdate.contracts[key as keyof Network['contracts']] =
              value as any
          }
        })
        network.schemas.forEach((schema) => {
          const existingSchemaIndex = networkToUpdate.schemas.findIndex(
            (s) => s.key === schema.key
          )
          if (existingSchemaIndex > -1) {
            networkToUpdate.schemas[existingSchemaIndex] = schema
          } else {
            networkToUpdate.schemas.push(schema)
          }
        })
      }

      // Verify the network is complete after updating.
      if (!isNetworkComplete(networkToUpdate)) {
        throw new Error(
          `Network at index ${index} is not complete after updating from ${deployFile}. Please make sure everything is configured correctly in ${this.networksConfigFile}.`
        )
      }
    }

    // Write updated networks config.
    fs.writeFileSync(
      this.networksConfigFile,
      JSON.stringify(networks, null, 2) + '\n'
    )
  }
}

export class DevEnv extends EnvBase {
  constructor({
    rpcUrl = 'http://127.0.0.1:8545',
    ipfsGateway = 'http://127.0.0.1:8080/ipfs/',
  }: EnvOverrides) {
    const networksConfigFile = 'config/networks.development.json'
    const networksConfigTemplateFile = networksConfigFile.replace(
      '.json',
      '.template.json'
    )
    if (!fs.existsSync(networksConfigTemplateFile)) {
      throw new Error(
        `Networks config template file ${networksConfigTemplateFile} does not exist`
      )
    }

    // Get the number of networks from the template file.
    const numNetworks = readJson<Network[]>(networksConfigTemplateFile).length

    super({
      rpcUrl,
      registry: 'http://localhost:8090',
      serviceName: 'trust-graph',
      triggerChain: 'evm:31337',
      submitChain: 'evm:31337',
      ipfs: {
        pinApi: 'http://127.0.0.1:5001/api/v0/add?pin=true',
        gateway: ipfsGateway,
      },
      networksConfigFile,
      deployContracts: [
        {
          name: 'EAS',
          script: 'script/DeployEAS.s.sol:DeployEAS',
          sig: 'run()',
          args: () => [],
        },
        // Deploy the SP1 ZK verifier adapter that gates MerkleSnapshot root updates. This is the
        // producer path: the root is proven by SP1 (see ZK_ARCHITECTURE.md). Points at an existing
        // canonical SP1 gateway (SP1_VERIFIER_GATEWAY) and the guest image id (SP1_PROGRAM_VKEY);
        // both default to zero for local scaffolding.
        {
          name: 'ZK Verifier',
          script: 'script/DeployZkVerifier.s.sol:DeployZkVerifier',
          sig: 'run(string,bytes32)',
          args: () => [
            process.env.SP1_VERIFIER_GATEWAY || ZERO_ADDRESS,
            process.env.SP1_PROGRAM_VKEY || ZERO_BYTES32,
          ],
        },
        {
          name: 'Network',
          script: 'script/DeployNetwork.s.sol:DeployScript',
          sig: 'run(string,bytes32,string,string,bool,string,uint256,uint256)',
          args: () => [
            readJsonKey('.docker/zk_verifier_deploy.json', 'zk_verifier'),
            process.env.PARAMS_HASH || ZERO_BYTES32,
            readJsonKey('.docker/eas_deploy.json', 'eas'),
            readJsonKey('.docker/eas_deploy.json', 'schema_registrar'),
            true,
            'dev',
            0,
            numNetworks,
          ],
        },
        // Deploy one Zodiac-enabled Safe (with MerkleGovModule) per network, wired to that
        // network's ZK-proven MerkleSnapshot root. Must run AFTER Network so the network deploy
        // JSONs (with merkle_snapshot addresses) exist.
        ...Array.from(
          { length: numNetworks },
          (_, index): ContractDeployment => ({
            name: `Safe: ${index}`,
            script: 'script/DeployZodiacSafes.s.sol:DeployZodiacSafes',
            sig: 'run(string)',
            args: () => [
              readJsonKey(
                `config/network_deploy_dev_${index}.json`,
                'contracts.merkle_snapshot'
              ),
            ],
          })
        ),
        // Deploy the two governance timelocks and hand off MerkleSnapshot authority to them
        // (deployer renounces its bootstrap roles). Must run AFTER Network so the network deploy
        // JSONs (with merkle_snapshot addresses) exist.
        {
          name: 'Timelocks',
          script: 'script/DeployTimelocks.s.sol:DeployTimelocks',
          sig: 'run(string,string,uint256,uint256,string,uint256,uint256)',
          args: () => [
            process.env.TIMELOCK_PROPOSER || '', // '' -> deployer
            process.env.TIMELOCK_EXECUTOR || '', // '' -> deployer
            process.env.CONSTITUTIONAL_DELAY || '0', // 0 -> 14 days
            process.env.OPERATIONAL_DELAY || '0', // 0 -> 2 days
            'dev',
            0,
            numNetworks,
          ],
        },
      ],
      // After all contracts are deployed, update the networks config file.
      postDeployContracts: () => {
        // Replace the networks config file with the template.
        fs.copyFileSync(networksConfigTemplateFile, this.networksConfigFile)
        this.updateNetworksConfigWithDeployments('dev')
      },
    })
  }

  async uploadToIpfs(file: string, apiKey?: string): Promise<string> {
    const filePath = path.resolve(file)
    if (!fs.existsSync(filePath)) {
      throw new Error(`File ${filePath} does not exist`)
    }

    const formData = new FormData()
    formData.append(
      'file',
      new Blob([new Uint8Array(fs.readFileSync(filePath))])
    )

    const response = await fetch(this.ipfs.pinApi, {
      method: 'POST',
      body: formData,
      ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    })

    if (!response.ok) {
      throw new Error(
        `Failed to upload file to IPFS: ${response.status} ${response.statusText}. Body: ${await response.text().catch(() => '<unable to read body>')}`
      )
    }

    const { Hash } = await response.json()

    // Verify the upload by querying IPFS for the file and checking the content
    // exists.
    let error
    for (let i = 0; i < 5; i++) {
      try {
        const content = await this.queryIpfs(Hash)
        if (content) {
          return Hash
        } else {
          throw new Error('Uploaded file content empty.')
        }
      } catch (err) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        error = err
      }
    }

    throw new Error(`Failed to verify IPFS upload: ${error}`)
  }
}

export class ProdEnv extends EnvBase {
  constructor({
    rpcUrl = 'https://optimism-rpc.publicnode.com',
    ipfsGateway = 'https://gateway.pinata.cloud/ipfs/',
  }: EnvOverrides) {
    const networksConfigFile = 'config/networks.production.json'
    if (!fs.existsSync(networksConfigFile)) {
      throw new Error(
        `Networks config file ${networksConfigFile} does not exist`
      )
    }

    const networks = readJson<Network[]>(networksConfigFile)

    super({
      rpcUrl,
      registry: 'https://wa.dev',
      serviceName: 'trust-graph',
      // optimism
      triggerChain: 'evm:10',
      submitChain: 'evm:10',
      ipfs: {
        pinApi: 'https://uploads.pinata.cloud/v3/files',
        gateway: ipfsGateway,
      },
      networksConfigFile,
      deployContracts: [
        {
          name: 'EAS',
          script: 'script/DeployEAS.s.sol:DeployEAS',
          sig: 'run()',
          args: () => [],
          // Skip if EAS is already deployed.
          skip: () =>
            readJsonKeyIfFileExists('.docker/eas_deploy.json', 'eas') !==
            undefined,
        },
        // Deploy the SP1 ZK verifier adapter (the root producer path; the root is proven by SP1,
        // see ZK_ARCHITECTURE.md). Points at the canonical SP1 Groth16 gateway
        // (SP1_VERIFIER_GATEWAY) and the guest image id (SP1_PROGRAM_VKEY) — both REQUIRED for
        // prod; the script reverts on a zero value.
        {
          name: 'ZK Verifier',
          script: 'script/DeployZkVerifier.s.sol:DeployZkVerifier',
          sig: 'run(string,bytes32)',
          args: () => [
            process.env.SP1_VERIFIER_GATEWAY || '',
            requireProdBytes32('SP1_PROGRAM_VKEY'),
          ],
        },
        ...networks.flatMap((network, index): ContractDeployment[] => [
          {
            name: `Network: ${network.name}`,
            script: 'script/DeployNetwork.s.sol:DeployScript',
            sig: 'run(string,bytes32,string,string,bool,string,uint256,uint256)',
            args: () => [
              readJsonKey('.docker/zk_verifier_deploy.json', 'zk_verifier'),
              requireProdBytes32('PARAMS_HASH'),
              readJsonKey('.docker/eas_deploy.json', 'eas'),
              readJsonKey('.docker/eas_deploy.json', 'schema_registrar'),
              false,
              'prod',
              index,
              1,
            ],
            // Skip if network is already complete.
            skip: () => isNetworkComplete(network),
          },
          {
            name: `Safe: ${network.name}`,
            script: 'script/DeployZodiacSafes.s.sol:DeployZodiacSafes',
            sig: 'run(string)',
            args: () => [
              readJsonKey(
                `config/network_deploy_prod_${index}.json`,
                'contracts.merkle_snapshot'
              ),
            ],
            // Skip if the safe is already deployed / disabled for this network.
            skip: () =>
              isNetworkSafeZodiacSignerSyncDisabledOrComplete(network),
          },
          // Deploy + wire the governance timelocks for this network's MerkleSnapshot, then hand off
          // (deployer renounces bootstrap roles). Runs AFTER the network deploy JSON exists.
          {
            name: `Timelocks: ${network.name}`,
            script: 'script/DeployTimelocks.s.sol:DeployTimelocks',
            sig: 'run(string,string,uint256,uint256,string,uint256,uint256)',
            args: () => [
              process.env.TIMELOCK_PROPOSER || '', // '' -> deployer (set to the founding multisig)
              process.env.TIMELOCK_EXECUTOR || '', // '' -> deployer
              process.env.CONSTITUTIONAL_DELAY || '0', // 0 -> 14 days
              process.env.OPERATIONAL_DELAY || '0', // 0 -> 2 days
              'prod',
              index,
              1,
            ],
            // Skip if the network is already complete (timelocks wired as part of that network).
            skip: () => isNetworkComplete(network),
          },
        ]),
      ],
      // After all contracts are deployed, update the networks config file.
      postDeployContracts: () => {
        this.updateNetworksConfigWithDeployments('prod')
      },
    })
  }

  async uploadToIpfs(file: string, apiKey?: string): Promise<string> {
    if (!apiKey) {
      throw new Error('API key is required for IPFS uploads')
    }

    const filePath = path.resolve(file)
    if (!fs.existsSync(filePath)) {
      throw new Error(`File ${filePath} does not exist`)
    }

    const formData = new FormData()
    formData.append(
      'file',
      new Blob([new Uint8Array(fs.readFileSync(filePath))])
    )
    formData.append('network', 'public')
    formData.append('name', `service-${Date.now()}.json`)

    const response = await fetch(this.ipfs.pinApi, {
      method: 'POST',
      body: formData,
      headers: { Authorization: `Bearer ${apiKey}` },
    })

    if (!response.ok) {
      throw new Error(
        `Failed to upload file to IPFS: ${response.status} ${response.statusText}. Body: ${await response.text().catch(() => '<unable to read body>')}`
      )
    }

    const {
      data: { cid },
    } = await response.json()

    // Verify the upload by querying IPFS for the file and checking the content
    // exists.
    let error
    for (let i = 0; i < 5; i++) {
      try {
        const content = await this.queryIpfs(cid)
        if (content) {
          return cid
        } else {
          throw new Error('Uploaded file content empty.')
        }
      } catch (err) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        error = err
      }
    }

    throw new Error(`Failed to verify IPFS upload: ${error}`)
  }
}

/**
 * Default option values.
 */
export const DEFAULT_OPTIONS: Record<string, () => string | undefined> = {
  rpcUrl: () => process.env.RPC_URL,
  fundedKey: () => process.env.FUNDED_KEY,
}

/**
 * Initialize the program by parsing the arguments and returning the relevant
 * environment and options.
 */
export const initProgram = (program: Command): ProgramContext => {
  const dotenv = loadDotenv()

  program.parse(process.argv)

  const options = program.opts()
  // Set default environment before applying default options, since some default
  // options depend on the environment.
  if (!options.env) {
    options.env = process.env.DEPLOY_ENV?.toLowerCase() || 'dev'
  }

  const appliedOptions = applyDefaultOptions(options)
  const env = getEnv(options.env, options)

  return {
    envName: options.env,
    env,
    options: appliedOptions,
    dotenv,
  }
}

/**
 * Gets the environment variables for the given environment name. Throws an
 * error if the environment name is invalid.
 *
 * @param envName - The name of the environment
 * @returns The environment variables
 */
export const getEnv = (
  envName: EnvName,
  overrides: EnvOverrides = {}
): IEnv => {
  const env = EnvBase.get(envName, overrides)
  if (!env) {
    throw new Error(`Invalid environment: ${envName}`)
  }

  return env
}

/**
 * Apply default option values.
 *
 * @param options - The options to apply default values to
 * @param env - The environment
 * @returns The options with default values applied
 */
export const applyDefaultOptions = (options: Record<string, any>) =>
  Object.entries(DEFAULT_OPTIONS).reduce((acc, [key, value]) => {
    if (!options[key]) {
      acc[key] = value()
    }
    return acc
  }, options)
