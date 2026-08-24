import fs from 'fs'
import path from 'path'

import { Command } from 'commander'

import {
  ChainProfile,
  ChainTarget,
  ContractDeployment,
  DeploymentStage,
  EnvName,
  EnvOverrides,
  IEnv,
  Network,
  NetworkDeploy,
  ProgramContext,
  ZodiacSafesDeploy,
} from './types'
import { CHAIN_PROFILES, resolveDeploymentSelection } from './profiles'
import {
  deploymentRecord,
  loadReleaseManifest,
  readBroadcastDeployments,
  validateReleaseManifest,
} from './release-manifest'
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

/**
 * Read a REQUIRED guest vkey for a per-program verifier/factory deploy step; fail closed (throw)
 * if it is unset or zero. `DeployZkVerifier` falls back to `SP1_PROGRAM_VKEY` (the trust-graph
 * ROOT program) whenever its vkey argument is zero, so letting an unset weighted/composition vkey
 * through would silently pin the wrong program's verifier — a factory whose instances no proof of
 * their own program can ever satisfy.
 */
function requireProgramVkey(name: string, program: string): string {
  const value = process.env[name]
  if (!value || /^0x0{64}$/i.test(value)) {
    throw new Error(
      `${name} must be set to the ${program} guest vkey (got ${value ?? 'unset'}). ` +
        `Compute it with: cargo run -p trustgraph-prover -- ${program} vkey, or use ` +
        `\`task demo:deploy\`, which derives every vkey from this checkout's guests.`
    )
  }
  return value
}

/** Require an explicit, nonzero uint64 deployment value instead of silently choosing policy. */
function requireProdUint64(name: string): string {
  const value = process.env[name]
  if (!value || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(
      `${name} must be set to a positive integer number of blocks`
    )
  }
  if (BigInt(value) > (1n << 64n) - 1n) {
    throw new Error(`${name} exceeds uint64`)
  }
  return value
}

function requireReleaseCommit(): string {
  const value = process.env.DEPLOYMENT_COMMIT
  if (!value || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error('DEPLOYMENT_COMMIT must be the exact 40-hex release commit')
  }
  return value
}

function requireReleaseDigest(): string {
  const value = process.env.SP1_PROGRAM_ELF_SHA256
  if (!value || !/^0x[0-9a-f]{64}$/i.test(value) || /^0x0{64}$/i.test(value)) {
    throw new Error(
      'SP1_PROGRAM_ELF_SHA256 must be the nonzero SHA-256 digest of the archived trust-graph ELF'
    )
  }
  return value
}

type EnvConstructorOptions = Omit<
  IEnv,
  'uploadToIpfs' | 'generateDeploymentSummary' | 'generateReleaseManifest'
>

abstract class EnvBase implements IEnv {
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

  constructor(options: EnvConstructorOptions) {
    this.stage = options.stage
    this.profile = options.profile
    this.rpcUrl = options.rpcUrl
    this.registry = options.registry
    this.serviceName = options.serviceName
    this.triggerChain = options.triggerChain
    this.submitChain = options.submitChain
    this.ipfs = options.ipfs
    this.networksConfigFile = options.networksConfigFile
    this.deployContracts = options.deployContracts
    this.postDeployContracts = options.postDeployContracts
    this.validateDeployment = options.validateDeployment
  }

  static get(
    stage: DeploymentStage,
    target: ChainTarget,
    overrides: EnvOverrides = {}
  ): IEnv {
    switch (target) {
      case 'local':
        if (stage !== 'development') break
        return new DevEnv(overrides)
      case 'optimism':
        if (stage !== 'production') break
        return new ProdEnv(overrides)
      case 'sepolia':
        if (stage !== 'production') break
        return new SepoliaEnv(overrides)
      case 'mainnet':
        throw new Error(
          'Ethereum mainnet has a typed profile but no authorized deploy plan yet; complete Sepolia first'
        )
    }

    throw new Error(`Invalid deployment selection: ${stage}/${target}`)
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
      // The instance factory + registry (absent until `DeployFactory` has run on this box). The
      // indexer reads `factory.factory` from here and discovers every trust-graph instance's
      // snapshot / resolver / distributor from its `InstanceCreated` events, so this one address is
      // all the trust-graph configuration the indexer needs.
      factory: readJsonIfFileExists('.docker/factory_deploy.json'),
      // One per chain: the frontend wizard calls this wrapper so a new instance, DAO Safe,
      // snapshot-specific Merkle governance, sealed owner guard, and delayed recovery module are
      // born in one transaction. The base factory remains the canonical event/catalog source.
      governedFactory: readJsonIfFileExists(
        '.docker/governed_factory_deploy.json'
      ),
      // Governed wrappers for the weighted / compose programs (absent until their deploy scripts
      // have run). The indexer reads `governedWeightedFactory.governed_weighted_factory` and
      // `governedComposeFactory.governed_compose_factory` to discover wrapper-created instances;
      // the frontend generator exposes both so the workspaces can offer create-with-governance.
      governedWeightedFactory: readJsonIfFileExists(
        '.docker/governed_weighted_factory_deploy.json'
      ),
      governedComposeFactory: readJsonIfFileExists(
        '.docker/governed_compose_factory_deploy.json'
      ),
      // The weighted-prior factory (absent until `DeployWeightedTrustgraphsFactory` has run).
      // Both consumers read `weightedFactory.weighted_factory`: the frontend generator puts it in
      // config so `/create/weighted` can transact, and the indexer discovers every weighted
      // instance's controller/resolver/snapshot from the factory's creation events.
      weightedFactory: readJsonIfFileExists(
        '.docker/weighted_factory_deploy.json'
      ),
      // The trust-compose factory (absent until `DeployTrustComposeFactory` has run). One summary
      // key for both consumers: the frontend generator and the indexer both read
      // `trustComposeFactory.trust_compose_factory`.
      trustComposeFactory: readJsonIfFileExists(
        '.docker/trust_compose_factory_deploy.json'
      ),
      // The contributions round factory (absent until `DeployContributionsFactory` has run).
      // The indexer reads `contributionsFactory.contributions_factory` and discovers every
      // round's resolver / snapshot / distributor from its creation events.
      contributionsFactory: readJsonIfFileExists(
        '.docker/contributions_factory_deploy.json'
      ),
      // The chain's ProvingVault, as a bare address string — `packages/indexer/ponder.config.ts` reads
      // `summary.provingVault` and disables the source entirely when it is absent, so omitting it
      // here does not fail loudly, it just silently indexes no deposits, claims or credits.
      provingVault: readJsonKeyIfFileExists<string>(
        '.docker/proving_vault_deploy.json',
        'proving_vault'
      ),
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
      // DeployZodiacSafes writes a single .docker/zodiac_safes_deploy.json (the Safe + its
      // MerkleGovModule + SignerSyncZkModule). For a single-network deploy this is that network's
      // Safe; a multi-network deploy reuses the file, so the last-deployed Safe wins (fine for the
      // local fork demo — see research/operations/trust-graph/runbook.md for the real loop).
      const zodiacSafesDeployData = readJsonIfFileExists<ZodiacSafesDeploy>(
        '.docker/zodiac_safes_deploy.json'
      )

      const network: Network = {
        ...networks[index],
        contracts: {
          merkleSnapshot: deployData.contracts.merkle_snapshot,
          easIndexerResolver: deployData.contracts.eas_indexer_resolver,
          merkleFundDistributor: deployData.contracts.fund_distributor,
          merkleGovModule: zodiacSafesDeployData?.safe?.merkle_gov_module,
          safe: zodiacSafesDeployData && {
            factory: zodiacSafesDeployData.safe_factory,
            singleton: zodiacSafesDeployData.safe_singleton,
            proxy: zodiacSafesDeployData.safe.address,
            signerSyncManager: zodiacSafesDeployData.safe.signer_sync_module,
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

    // Get the number of EAS-vouching networks from the template file. Program-tagged entries
    // (e.g. `program: "contributions"`) have their own instance deploy step and MUST come after
    // every vouching entry in the template: `network_deploy_dev_<i>.json` maps to template index
    // `i`, so vouching entries own the leading indices.
    const numNetworks = readJson<(Network & { program?: string })[]>(
      networksConfigTemplateFile
    ).filter((network) => !network.program).length

    // `SP1_VERIFIER_GATEWAY` names a real per-chain Succinct deployment. On a plain (non-fork)
    // anvil that address has NO CODE, so every `MerkleSnapshot.submitProof` reverts inside
    // `gateway.verifyProof` before any real check runs — a freshly deployed local stack silently
    // cannot accept a proof at all. So dev stands up a `MockSP1Gateway` and points the verifier
    // adapters at it. Set `DEV_MOCK_SP1_GATEWAY=false` when running against a fork, where the real
    // gateway is part of forked state and `submitProof` genuinely verifies.
    //
    // The stub is at the GATEWAY seam only: the real `SP1JournalVerifier` still runs, so journal
    // digest binding, vkey pinning and proof-blob decoding are all exercised. Same seam
    // `tests/e2e/run.sh` uses; recorded in research/DEVIATIONS.md #1.
    const mockGateway = process.env.DEV_MOCK_SP1_GATEWAY !== 'false'
    const gatewayAddress = () =>
      mockGateway
        ? readJsonKey('.docker/mock_gateway_deploy.json', 'gateway')
        : process.env.SP1_VERIFIER_GATEWAY || ZERO_ADDRESS

    super({
      stage: 'development',
      profile: CHAIN_PROFILES.local,
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
          script: 'contracts/script/DeployEAS.s.sol:DeployEAS',
          sig: 'run()',
          args: () => [],
        },
        {
          name: 'Mock SP1 Gateway',
          script: 'contracts/script/DeployMockGateway.s.sol:DeployMockGateway',
          sig: 'run(bytes32)',
          // Left unpinned: the root and signer verifiers share this gateway, so pinning it to
          // either program's vkey would reject the other. Each adapter pins its own vkey anyway.
          args: () => [ZERO_BYTES32],
          skip: () => !mockGateway,
        },
        // Deploy the SP1 ZK verifier adapter that gates MerkleSnapshot root updates. This is the
        // producer path: the root is proven by SP1 (see ZK_ARCHITECTURE.md). Points at the gateway
        // resolved above and the guest image id (SP1_PROGRAM_VKEY, zero = local scaffolding).
        {
          name: 'ZK Verifier',
          script: 'contracts/script/DeployZkVerifier.s.sol:DeployZkVerifier',
          sig: 'run(string,bytes32,string)',
          args: () => [
            gatewayAddress(),
            process.env.SP1_PROGRAM_VKEY || ZERO_BYTES32,
            '',
          ],
        },
        // The chain's instance directory. One per chain; the factory below is granted
        // OPERATOR_ROLE on it so creating a network is permissionless *through the factory* while
        // rewriting a record stays with the operational timelock.
        {
          name: 'Instance Registry',
          script:
            'contracts/script/DeployInstanceRegistry.s.sol:DeployInstanceRegistry',
          sig: 'run(string,string)',
          args: () => ['', ''],
        },
        // The proving tank communities top up so somebody keeps proving their scores
        // (docs/build/run-a-prover.md). MUST precede the factory: the vault is a factory constructor
        // argument and it is what makes `createInstance` payable, so the reverse order gives you a
        // factory that permanently reverts on any prepay. Locally it brings its own mock ETH/USD
        // feed and TestUSDC; off-devnet both are required from the environment.
        {
          name: 'Proving Vault',
          script:
            'contracts/script/DeployProvingVault.s.sol:DeployProvingVault',
          sig: 'run(string)',
          args: () => [
            readJsonKey(
              '.docker/instance_registry_deploy.json',
              'instance_registry'
            ),
          ],
          skip: () => process.env.SKIP_PROVING_VAULT === 'true',
        },
        // The permissionless instance factory (research/INSTANCE_FACTORY.md). Needs EAS, the
        // schema registrar, the trust-graph verifier, and the registry — so it runs after all four.
        {
          name: 'Factory',
          script: 'contracts/script/DeployFactory.s.sol:DeployFactory',
          sig: 'run(string,string,string,string,uint64,string)',
          args: () => [
            readJsonKey('.docker/eas_deploy.json', 'eas'),
            readJsonKey('.docker/eas_deploy.json', 'schema_registrar'),
            readJsonKey('.docker/zk_verifier_deploy.json', 'zk_verifier'),
            readJsonKey(
              '.docker/instance_registry_deploy.json',
              'instance_registry'
            ),
            // Epoch floor in blocks. Mainnet's is ~30 days (what hosted proving commits to);
            // locally it is one block so a dev proving loop is never waiting on the schedule.
            process.env.FACTORY_EPOCH_FLOOR || '1',
            // The vault, if one was deployed. Empty = no prepay path on this factory, and
            // `createInstance` then reverts on any `msg.value` rather than silently keeping it.
            readJsonKeyIfFileExists<string>(
              '.docker/proving_vault_deploy.json',
              'proving_vault'
            ) || '',
          ],
        },
        // The governed wrappers pin the signer verifier/vkey immutably, so the dedicated signer
        // adapter must exist before any wrapper is deployed. Never let the signer adapter fall
        // back to the root guest's vkey.
        {
          name: 'Signer ZK Verifier',
          script: 'contracts/script/DeployZkVerifier.s.sol:DeployZkVerifier',
          sig: 'run(string,bytes32,string)',
          args: () => [
            gatewayAddress(),
            requireProgramVkey('SP1_SIGNER_PROGRAM_VKEY', 'signer'),
            'signer',
          ],
        },
        // The browser-facing creation seam. It has a shared Safe singleton/factory and wraps the
        // canonical instance factory so every wizard-created controller is Safe-owned from
        // version one, with delayed member/recovery modules and a sealed owner-execution guard
        // installed before the transaction returns.
        {
          name: 'Governed Factory',
          script:
            'contracts/script/DeployGovernedTrustgraphsFactory.s.sol:DeployGovernedTrustgraphsFactory',
          sig: 'run(string)',
          args: () => [readJsonKey('.docker/factory_deploy.json', 'factory')],
        },
        // Deploy the WEIGHTED verifier adapter (bound to the trust-graph-weighted guest's vkey —
        // a different program than the root). Own output file (`zk_verifier_weighted_deploy.json`)
        // so the root verifier's artifact is untouched.
        {
          name: 'Weighted ZK Verifier',
          script: 'contracts/script/DeployZkVerifier.s.sol:DeployZkVerifier',
          sig: 'run(string,bytes32,string)',
          args: () => [
            gatewayAddress(),
            requireProgramVkey(
              'SP1_WEIGHTED_PROGRAM_VKEY',
              'trust-graph-weighted'
            ),
            'weighted',
          ],
        },
        // The weighted-prior creation seam: the isolated `trust-graph-weighted` factory the
        // `/create/weighted` workspace calls. Same shape as Factory above (deployers + registrar
        // grant), plus the immutable prior-rotation review delay.
        {
          name: 'Weighted Factory',
          script:
            'contracts/script/DeployWeightedTrustgraphsFactory.s.sol:DeployWeightedTrustgraphsFactory',
          sig: 'run(string,string,string,string,uint64,uint48,string)',
          args: () => [
            readJsonKey('.docker/eas_deploy.json', 'eas'),
            readJsonKey('.docker/eas_deploy.json', 'schema_registrar'),
            readJsonKey(
              '.docker/zk_verifier_weighted_deploy.json',
              'zk_verifier'
            ),
            readJsonKey(
              '.docker/instance_registry_deploy.json',
              'instance_registry'
            ),
            process.env.FACTORY_EPOCH_FLOOR || '1',
            // Seconds between proposePrior and the earliest activatePrior. Short locally so a dev
            // rotation loop is never waiting on the review window; the script fails closed on
            // anything under a day for a non-dev chain.
            process.env.WEIGHTED_PRIOR_ACTIVATION_DELAY || '300',
            readJsonKeyIfFileExists<string>(
              '.docker/proving_vault_deploy.json',
              'proving_vault'
            ) || '',
          ],
        },
        // Deploy the COMPOSITION verifier adapter (bound to the trust-compose guest's vkey). Own
        // output file (`zk_verifier_composition_deploy.json`), same reasoning as above.
        {
          name: 'Composition ZK Verifier',
          script: 'contracts/script/DeployZkVerifier.s.sol:DeployZkVerifier',
          sig: 'run(string,bytes32,string)',
          args: () => [
            gatewayAddress(),
            requireProgramVkey('SP1_COMPOSITION_PROGRAM_VKEY', 'trust-compose'),
            'composition',
          ],
        },
        // The trust-compose creation seam: the isolated `trust-compose` factory the
        // `/create/composition` workspace calls, plus the `CompositionSourceAdapterFactory` whose
        // reviewed adapters are the only source identities the accumulator accepts. The factory
        // constructor cross-checks the vkey below against the verifier's own `programVKey()`.
        {
          name: 'Trust Compose Factory',
          script:
            'contracts/script/DeployTrustComposeFactory.s.sol:DeployTrustComposeFactory',
          sig: 'run(string,bytes32,string,uint64,uint48,string)',
          args: () => [
            readJsonKey(
              '.docker/zk_verifier_composition_deploy.json',
              'zk_verifier'
            ),
            requireProgramVkey('SP1_COMPOSITION_PROGRAM_VKEY', 'trust-compose'),
            readJsonKey(
              '.docker/instance_registry_deploy.json',
              'instance_registry'
            ),
            process.env.FACTORY_EPOCH_FLOOR || '1',
            // Seconds between proposePolicy and the earliest activatePolicy; same dev-short /
            // prod-fail-closed policy as the weighted delay above.
            process.env.COMPOSE_POLICY_ACTIVATION_DELAY || '300',
            readJsonKeyIfFileExists<string>(
              '.docker/proving_vault_deploy.json',
              'proving_vault'
            ) || '',
          ],
        },
        // Governed wrapper for the weighted factory: one transaction bootstraps a Safe, creates
        // the weighted instance through the base factory (admin = the Safe), installs the shared
        // gov module via the deployer, and seals authority. Reads every singleton (Safe factory,
        // authority / signer-sync / gov-module deployers) from the trust-graph governed factory's
        // artifact so the chain keeps one address per helper.
        {
          name: 'Governed Weighted Factory',
          script:
            'contracts/script/DeployGovernedWeightedTrustgraphsFactory.s.sol:DeployGovernedWeightedTrustgraphsFactory',
          sig: 'run(string)',
          args: () => [
            readJsonKey(
              '.docker/weighted_factory_deploy.json',
              'weighted_factory'
            ),
          ],
        },
        // Governed wrapper for the trust-compose factory; same shape and shared singletons.
        {
          name: 'Governed Compose Factory',
          script:
            'contracts/script/DeployGovernedTrustComposeFactory.s.sol:DeployGovernedTrustComposeFactory',
          sig: 'run(string)',
          args: () => [
            readJsonKey(
              '.docker/trust_compose_factory_deploy.json',
              'trust_compose_factory'
            ),
          ],
        },
        // The dev-seed networks, created THROUGH the factory — one catalog, and the local stack
        // exercises the same path a community will. Still writes
        // `config/network_deploy_dev_<i>.json` (a derived artifact now) because the Safe, timelock
        // and contributions steps below read it. The post-deploy merge prunes artifacts when this
        // seed list shrinks so an old index cannot be mistaken for a current network.
        {
          name: 'Create Instances',
          script:
            'contracts/script/CreateDevInstances.s.sol:CreateDevInstances',
          sig: 'run(string,string,string,string,uint256,uint256,bool,uint256,uint96)',
          args: () => [
            readJsonKey('.docker/factory_deploy.json', 'factory'),
            // The governance params. Unlike the old DeployNetwork path, the factory derives
            // `schema_uid`, `accumulator` and `chain_id` itself — the file supplies only knobs.
            process.env.PARAMS_JSON || 'params.json',
            networksConfigTemplateFile,
            'dev',
            0,
            numNetworks,
            // The Zodiac Safe does not exist yet. AttachDevDistributor adds the fund immediately
            // after Safe deployment, using the factory's Safe-only attachment path.
            false,
            process.env.DEV_SEED_PREPAY_WEI || '0',
            process.env.DEV_SEED_MAX_PER_ROOT_USD || '0',
          ],
        },
        // The contributions ROUND factory (network-creation GOAL M6). One per chain: the shared
        // contributions SP1JournalVerifier (CONTRIBUTIONS_PROGRAM_VKEY; unset = a nonzero dev
        // placeholder, valid only against the mock gateway), the controller deployer, the factory
        // (reusing the base factory's snapshot/distributor deployer singletons), and the
        // append-only registrar grant. Replaces the per-instance DeployContributionsInstance
        // script in this chain.
        {
          name: 'Contributions Factory',
          script:
            'contracts/script/DeployContributionsFactory.s.sol:DeployContributionsFactory',
          sig: 'run(string,string,string,string,string,string,uint64)',
          args: () => [
            readJsonKey('.docker/eas_deploy.json', 'eas'),
            readJsonKey('.docker/eas_deploy.json', 'schema_registrar'),
            // The same gateway the root/signer verifiers were pointed at. Without this the
            // script falls back to the SP1_VERIFIER_GATEWAY env var — Succinct's real per-chain
            // address, no code on a plain anvil — and the contributions verifier immutably
            // reverts every submitProof while the trust instance (built over the mock) works.
            gatewayAddress(),
            readJsonKey(
              '.docker/instance_registry_deploy.json',
              'instance_registry'
            ),
            readJsonKey('.docker/factory_deploy.json', 'snapshot_deployer'),
            readJsonKey('.docker/factory_deploy.json', 'distributor_deployer'),
            process.env.FACTORY_EPOCH_FLOOR || '1',
          ],
        },
        // Deploy one Zodiac-enabled Safe (MerkleGovModule + SignerSyncZkModule) per network, wired to
        // that network's ZK-proven MerkleSnapshot root and the signer verifier above. Must run AFTER
        // Network so the network deploy JSONs (with merkle_snapshot addresses) exist.
        ...Array.from(
          { length: numNetworks },
          (_, index): ContractDeployment[] => [
            {
              name: `Safe: ${index}`,
              script:
                'contracts/script/DeployZodiacSafes.s.sol:DeployZodiacSafes',
              sig: 'run(string,string,string)',
              args: () => [
                readJsonKey(
                  `config/network_deploy_dev_${index}.json`,
                  'contracts.merkle_snapshot'
                ),
                readJsonKey(
                  '.docker/zk_verifier_signer_deploy.json',
                  'zk_verifier'
                ),
                readJsonKey(
                  `config/network_deploy_dev_${index}.json`,
                  'contracts.params_controller'
                ),
              ],
            },
            {
              name: `Safe-owned distributor: ${index}`,
              script:
                'contracts/script/AttachDevDistributor.s.sol:AttachDevDistributor',
              sig: 'run(string,string,string,string)',
              args: () => [
                readJsonKey('.docker/factory_deploy.json', 'factory'),
                readJsonKey(
                  `config/network_deploy_dev_${index}.json`,
                  'contracts.merkle_snapshot'
                ),
                readJsonKey('.docker/zodiac_safes_deploy.json', 'safe.address'),
                `config/network_deploy_dev_${index}.json`,
              ],
            },
          ]
        ).flat(),
        // The parent deployer still holds constitutional authority here, while the round itself
        // and its mandatory distributor are owned by network 0's initialized Safe.
        {
          name: 'Contributions Round',
          script:
            'contracts/script/CreateDevContributionsRound.s.sol:CreateDevContributionsRound',
          sig: 'run(string,string,string,string,string,string,string)',
          args: () => {
            const paramsFile =
              process.env.CONTRIBUTIONS_PARAMS_JSON ||
              'params.contributions.json'
            if (!fs.existsSync(paramsFile)) {
              fs.copyFileSync(
                'tests/e2e/params.contributions.template.json',
                paramsFile
              )
            }
            return [
              readJsonKey(
                '.docker/contributions_factory_deploy.json',
                'contributions_factory'
              ),
              readJsonKey(
                'config/network_deploy_dev_0.json',
                'contracts.merkle_snapshot'
              ),
              paramsFile,
              'Demo Co-op Contributions',
              readJsonKeyIfFileExists<string>(
                '.docker/proving_vault_deploy.json',
                'usdc'
              ) || '',
              readJsonKey(
                'config/network_deploy_dev_0.json',
                'contracts.governance_safe'
              ),
              'dev',
            ]
          },
        },
        // Deploy the two governance timelocks and hand off MerkleSnapshot authority to them
        // (deployer renounces its bootstrap roles). Must run AFTER Network so the network deploy
        // JSONs (with merkle_snapshot addresses) exist.
        {
          name: 'Timelocks',
          script: 'contracts/script/DeployTimelocks.s.sol:DeployTimelocks',
          sig: 'run(string,string,string,string,string,uint256,uint256,string,uint256,uint256)',
          args: () => [
            process.env.CONSTITUTIONAL_TIMELOCK_PROPOSER ||
              process.env.TIMELOCK_PROPOSER ||
              '', // '' -> deployer
            process.env.CONSTITUTIONAL_TIMELOCK_CANCELLER ||
              '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // local Anvil account #1
            process.env.OPERATIONAL_TIMELOCK_PROPOSER ||
              process.env.TIMELOCK_PROPOSER ||
              '', // '' -> deployer
            process.env.OPERATIONAL_TIMELOCK_CANCELLER ||
              '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // local Anvil account #1
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
        // The number of dev seeds can shrink. Per-network deploy files are derived artifacts, but
        // their fixed names survive between runs; without pruning the now-out-of-range files, the
        // merge below treats an old network_deploy_dev_1.json as the program entry at index 1 (or
        // errors when the stale index is beyond the shorter template).
        for (const file of fs.readdirSync('config')) {
          const match = file.match(/^network_deploy_dev_(\d+)\.json$/)
          if (match && Number(match[1]) >= numNetworks) {
            fs.unlinkSync(path.join('config', file))
          }
        }

        // Replace the networks config file with the template.
        fs.copyFileSync(networksConfigTemplateFile, this.networksConfigFile)
        this.updateNetworksConfigWithDeployments('dev')
        // Contributions rounds no longer live in the networks config: the indexer catalogs them
        // from ContributionsFactory's creation event and the frontend reads its
        // /contributions/instances route.
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
      stage: 'production',
      profile: CHAIN_PROFILES.optimism,
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
          script: 'contracts/script/DeployEAS.s.sol:DeployEAS',
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
          script: 'contracts/script/DeployZkVerifier.s.sol:DeployZkVerifier',
          sig: 'run(string,bytes32,string)',
          args: () => [
            process.env.SP1_VERIFIER_GATEWAY || '',
            requireProdBytes32('SP1_PROGRAM_VKEY'),
            '',
          ],
        },
        // Deploy the SIGNER verifier (bound to the signer guest's vkey — a different program than the
        // root) to its own output file so per-network Network steps still read the root verifier.
        {
          name: 'Signer ZK Verifier',
          script: 'contracts/script/DeployZkVerifier.s.sol:DeployZkVerifier',
          sig: 'run(string,bytes32,string)',
          args: () => [
            process.env.SP1_VERIFIER_GATEWAY || '',
            requireProdBytes32('SP1_SIGNER_PROGRAM_VKEY'),
            'signer',
          ],
        },
        ...networks.flatMap((network, index): ContractDeployment[] => [
          {
            name: `Network: ${network.name}`,
            script: 'contracts/script/DeployNetwork.s.sol:DeployScript',
            sig: 'run(string,string,string,string,bool,string,string,uint256,uint256,uint64)',
            args: () => [
              readJsonKey('.docker/zk_verifier_deploy.json', 'zk_verifier'),
              // Path to the governance params; the script computes paramsHash from it on-chain after
              // registering the schema. For multiple networks give each its own params file
              // (PARAMS_JSON), since each has a distinct resolver -> schema UID -> paramsHash.
              process.env.PARAMS_JSON || 'params.json',
              readJsonKey('.docker/eas_deploy.json', 'eas'),
              readJsonKey('.docker/eas_deploy.json', 'schema_registrar'),
              Boolean(process.env.DISTRIBUTOR_SAFE),
              process.env.DISTRIBUTOR_SAFE || '',
              'prod',
              index,
              1,
              // Direct/legacy deploys do not inherit the factory's EPOCH_FLOOR. Require an
              // explicit schedule so a missing setting cannot silently produce an unscheduled
              // network whose proof submitter chooses the epoch boundaries.
              requireProdUint64('NETWORK_EPOCH_LENGTH'),
            ],
            // Skip if network is already complete.
            skip: () => isNetworkComplete(network),
          },
          {
            name: `Safe: ${network.name}`,
            script:
              'contracts/script/DeployZodiacSafes.s.sol:DeployZodiacSafes',
            sig: 'run(string,string)',
            args: () => [
              readJsonKey(
                `config/network_deploy_prod_${index}.json`,
                'contracts.merkle_snapshot'
              ),
              readJsonKey(
                '.docker/zk_verifier_signer_deploy.json',
                'zk_verifier'
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
            script: 'contracts/script/DeployTimelocks.s.sol:DeployTimelocks',
            sig: 'run(string,string,string,string,string,uint256,uint256,string,uint256,uint256)',
            args: () => [
              process.env.CONSTITUTIONAL_TIMELOCK_PROPOSER ||
                process.env.TIMELOCK_PROPOSER ||
                '', // '' -> deployer
              process.env.CONSTITUTIONAL_TIMELOCK_CANCELLER || '', // required by script
              process.env.OPERATIONAL_TIMELOCK_PROPOSER ||
                process.env.TIMELOCK_PROPOSER ||
                '', // '' -> deployer
              process.env.OPERATIONAL_TIMELOCK_CANCELLER || '', // required by script
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
 * Ethereum Sepolia public-release plan.
 *
 * This deliberately reuses only the modern local architecture: canonical EAS,
 * a real root verifier, the instance directory, optional vault, and the base
 * trust-graph factory. Weighted, composition, contributions, Zodiac, and
 * signer-sync are outside the first public testnet gate.
 */
export class SepoliaEnv extends EnvBase {
  private readonly releaseManifestFile = 'deployments/sepolia.json'

  constructor({
    rpcUrl,
    ipfsGateway = 'https://gateway.pinata.cloud/ipfs/',
  }: EnvOverrides) {
    if (!rpcUrl) {
      throw new Error(
        'Sepolia RPC URL is required (--rpc-url, RPC_URL, or PONDER_RPC_URL_11155111)'
      )
    }
    let parsedRpc: URL
    try {
      parsedRpc = new URL(rpcUrl)
    } catch {
      throw new Error('Sepolia RPC URL must be an absolute http(s) URL')
    }
    if (!['http:', 'https:'].includes(parsedRpc.protocol)) {
      throw new Error('Sepolia RPC URL must use http or https')
    }
    const manifest = loadReleaseManifest('deployments/sepolia.json')
    const requiredAddress = (name: string, value?: string | null): string => {
      if (
        !value ||
        !/^0x[0-9a-f]{40}$/i.test(value) ||
        /^0x0{40}$/i.test(value)
      ) {
        throw new Error(`${name} must be set to a nonzero public-chain address`)
      }
      return value
    }
    const gateway = () =>
      requiredAddress(
        'SP1_VERIFIER_GATEWAY',
        process.env.SP1_VERIFIER_GATEWAY || manifest.external.sp1Gateway
      )
    const vaultEnvironment = () => {
      const feed = requiredAddress(
        'ETH_USD_FEED',
        process.env.ETH_USD_FEED || manifest.external.ethUsdFeed
      )
      const usdc = requiredAddress(
        'USDC',
        process.env.USDC || manifest.external.usdc
      )
      // Sepolia's Chainlink ETH/USD feed is slower and less regular than mainnet's, so the
      // off-devnet default in DeployProvingVault (5400s = a mainnet hourly heartbeat plus 50%
      // grace) is too tight here. Measured over 15.5h of round history on 2026-08-23: mean gap
      // 2929s, worst gap 3696s, and the live answer was already 3348s old when sampled. 5400
      // would leave under half an hour of headroom, so one skipped heartbeat silently drops the
      // proving fee to zero. 7200 is roughly twice the observed worst gap. The failure is benign
      // either way (a stale answer pays no fee and still lands the root), but on the tighter
      // window a rehearsal would read zero fees often enough to look like a bug.
      const feedMaxStaleness = process.env.FEED_MAX_STALENESS || '7200'
      return {
        ETH_USD_FEED: feed,
        USDC: usdc,
        FEED_MAX_STALENESS: feedMaxStaleness,
      }
    }

    super({
      stage: 'production',
      profile: CHAIN_PROFILES.sepolia,
      rpcUrl,
      registry: process.env.SERVICE_REGISTRY_URL || '',
      serviceName: 'trust-graph',
      triggerChain: 'evm:11155111',
      submitChain: 'evm:11155111',
      ipfs: {
        pinApi: 'https://uploads.pinata.cloud/v3/files',
        gateway: ipfsGateway,
      },
      networksConfigFile: 'config/networks.sepolia.json',
      validateDeployment: () => {
        requireReleaseCommit()
        requireReleaseDigest()
        gateway()
        requireProdBytes32('SP1_PROGRAM_VKEY')
        requiredAddress(
          'INSTANCE_REGISTRY_ADMIN',
          process.env.INSTANCE_REGISTRY_ADMIN
        )
        requireProdUint64('FACTORY_EPOCH_FLOOR')
        if (process.env.SKIP_PROVING_VAULT !== 'true') vaultEnvironment()
      },
      deployContracts: [
        {
          name: 'Schema Registrar (canonical Sepolia EAS)',
          script: 'contracts/script/DeployEAS.s.sol:DeployEAS',
          sig: 'run(string,string)',
          args: () => [manifest.external.eas, manifest.external.schemaRegistry],
        },
        {
          name: 'Trust-graph ZK Verifier',
          script: 'contracts/script/DeployZkVerifier.s.sol:DeployZkVerifier',
          sig: 'run(string,bytes32,string)',
          args: () => [gateway(), requireProdBytes32('SP1_PROGRAM_VKEY'), ''],
        },
        {
          name: 'Instance Registry',
          script:
            'contracts/script/DeployInstanceRegistry.s.sol:DeployInstanceRegistry',
          sig: 'run(string,string)',
          args: () => [
            requiredAddress(
              'INSTANCE_REGISTRY_ADMIN',
              process.env.INSTANCE_REGISTRY_ADMIN
            ),
            '',
          ],
        },
        {
          name: 'Proving Vault',
          script:
            'contracts/script/DeployProvingVault.s.sol:DeployProvingVault',
          sig: 'run(string)',
          args: () => [
            readJsonKey(
              '.docker/instance_registry_deploy.json',
              'instance_registry'
            ),
          ],
          env: vaultEnvironment,
          skip: () => process.env.SKIP_PROVING_VAULT === 'true',
        },
        {
          name: 'Trustgraphs Factory',
          script: 'contracts/script/DeployFactory.s.sol:DeployFactory',
          sig: 'run(string,string,string,string,uint64,string)',
          args: () => [
            manifest.external.eas,
            readJsonKey('.docker/eas_deploy.json', 'schema_registrar'),
            readJsonKey('.docker/zk_verifier_deploy.json', 'zk_verifier'),
            readJsonKey(
              '.docker/instance_registry_deploy.json',
              'instance_registry'
            ),
            requireProdUint64('FACTORY_EPOCH_FLOOR'),
            process.env.SKIP_PROVING_VAULT === 'true'
              ? ''
              : readJsonKey(
                  '.docker/proving_vault_deploy.json',
                  'proving_vault'
                ),
          ],
        },
      ],
    })
  }

  generateReleaseManifest(): object {
    const base = loadReleaseManifest(this.releaseManifestFile)
    const broadcasts = readBroadcastDeployments('.', this.profile.chainId)
    const eas = readJsonIfFileExists<Record<string, string>>(
      '.docker/eas_deploy.json'
    )
    const verifier = readJsonIfFileExists<Record<string, string>>(
      '.docker/zk_verifier_deploy.json'
    )
    const registry = readJsonIfFileExists<Record<string, string>>(
      '.docker/instance_registry_deploy.json'
    )
    const vault =
      process.env.SKIP_PROVING_VAULT === 'true'
        ? null
        : readJsonIfFileExists<Record<string, string>>(
            '.docker/proving_vault_deploy.json'
          )
    const factory = readJsonIfFileExists<Record<string, string>>(
      '.docker/factory_deploy.json'
    )
    const contracts = {
      schemaRegistrar: deploymentRecord(eas?.schema_registrar, broadcasts),
      rootVerifier: deploymentRecord(verifier?.zk_verifier, broadcasts),
      instanceRegistry: deploymentRecord(
        registry?.instance_registry,
        broadcasts
      ),
      provingVault: deploymentRecord(vault?.proving_vault, broadcasts),
      trustgraphsFactory: deploymentRecord(factory?.factory, broadcasts),
    }
    const blocks = Object.values(contracts)
      .map((record) => record.block)
      .filter((block): block is number => block !== null)
    const manifest = {
      ...base,
      status: 'deployed' as const,
      deploymentCommit: requireReleaseCommit(),
      firstDeploymentBlock: blocks.length > 0 ? Math.min(...blocks) : null,
      external: {
        ...base.external,
        sp1Gateway:
          verifier?.sp1_gateway || process.env.SP1_VERIFIER_GATEWAY || null,
        ethUsdFeed: vault?.eth_usd_feed || null,
        usdc: vault?.usdc || base.external.usdc,
      },
      contracts,
      programs: {
        trustGraph: {
          ...base.programs.trustGraph,
          elfSha256: requireReleaseDigest(),
          vkey: verifier?.program_vkey || null,
        },
      },
    }
    return validateReleaseManifest(manifest, { requireComplete: true })
  }

  async uploadToIpfs(file: string, apiKey?: string): Promise<string> {
    if (!apiKey) throw new Error('API key is required for IPFS uploads')
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
        `Failed to upload file to IPFS: ${response.status} ${response.statusText}`
      )
    }
    const {
      data: { cid },
    } = await response.json()
    return cid
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
  const selection = resolveDeploymentSelection({
    stage: options.stage || process.env.DEPLOY_STAGE,
    target: options.chain || process.env.DEPLOY_TARGET,
  })
  options.env = selection.envName
  options.stage = selection.stage
  options.chain = selection.target
  const appliedOptions = applyDefaultOptions(options)
  if (!appliedOptions.rpcUrl) {
    appliedOptions.rpcUrl =
      process.env.RPC_URL || process.env[selection.profile.rpcEnv]
  }
  const env = getEnv(selection.stage, selection.target, appliedOptions)

  return {
    envName: selection.envName,
    stage: selection.stage,
    target: selection.target,
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
  stage: DeploymentStage,
  target: ChainTarget,
  overrides: EnvOverrides = {}
): IEnv => {
  const env = EnvBase.get(stage, target, overrides)
  if (!env) {
    throw new Error(`Invalid deployment selection: ${stage}/${target}`)
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
