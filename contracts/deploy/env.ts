import fs from 'fs'
import path from 'path'

import { Command } from 'commander'
import { type Hex, encodeFunctionData, keccak256, toBytes } from 'viem'

import { CHAIN_PROFILES, resolveDeploymentSelection } from './profiles'
import { generationManifestPath, planGeneration } from './generation'
import {
  DELIBERATE_EPOCH_FLOOR,
  PUBLIC_CHAIN_PLANS,
  type PublicChainTarget,
} from './public-chains'
import {
  type DeploymentRecord,
  type ReleaseManifest,
  deploymentRecord,
  loadReleaseManifest,
  readBroadcastDeployments,
  validateReleaseManifest,
} from './release-manifest'
import {
  ChainProfile,
  ChainTarget,
  ContractDeployment,
  DeploymentStage,
  EnvOverrides,
  IEnv,
  Network,
  NetworkDeploy,
  ProgramContext,
  ZodiacSafesDeploy,
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
  if (!v || !/^0x[0-9a-f]{64}$/i.test(v) || /^0x0{64}$/i.test(v)) {
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
  if (!value || !/^0x[0-9a-f]{64}$/i.test(value) || /^0x0{64}$/i.test(value)) {
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

/**
 * Bind the pinned guest vkeys to a published release's `guest-manifest.json`.
 *
 * The other checks around these values all test shape or freshness: `requireProdBytes32` says a
 * vkey is well-formed, `requireReleaseDigest` says a digest is well-formed, and the staleness
 * guard in `generateReleaseManifest` says `.docker/zk_verifier_deploy.json` agrees with
 * `SP1_PROGRAM_VKEY`. None of them can tell whether the pin itself is the right one, and on
 * 2026-08-25 that is precisely what reached Sepolia: `.env` pinned a LOCAL (non-`--docker`)
 * trust-graph build, `.docker` agreed with it because the same run wrote both, and
 * `SP1JournalVerifier` fixed `0x00d9bbff…` into an `immutable`. `TrustgraphsFactory.VERIFIER` is
 * immutable as well, so the price of that one wrong line was two redeploys rather than a setter.
 *
 * A vkey is a deterministic function of the guest ELF, which makes the pair checkable: (vkey,
 * elf_sha256) either appears in the release built at `DEPLOYMENT_COMMIT` or this is not that
 * release. The manifest is a release asset rather than a file in the repo on purpose — a
 * checked-in table is one more thing a local build can overwrite.
 */
function requireReleaseVkeys(): void {
  const file = process.env.GUEST_MANIFEST || 'guest-manifest.json'
  const commit = requireReleaseCommit()
  const hex = (value: string): string =>
    value.trim().toLowerCase().replace(/^0x/, '')

  if (!fs.existsSync(file)) {
    throw new Error(
      `${file} not found, so the pinned vkeys cannot be checked against the release they claim ` +
        `to come from. Fetch it next to this checkout:\n` +
        `  gh release download <tag> -R AInima-Collective/trustgraphs -p guest-manifest.json\n` +
        `(or point GUEST_MANIFEST at a copy). Deploying without it pins whatever the environment ` +
        `happens to hold, and SP1JournalVerifier.programVKey is immutable.`
    )
  }

  let manifest: {
    commit?: string
    tag?: string
    guest_build?: string
    builder_image?: string
    programs?: { program?: string; vkey?: string; elf_sha256?: string }[]
  }
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file} is not readable JSON: ${String(error)}`)
  }

  if (hex(manifest.commit || '') !== hex(commit)) {
    throw new Error(
      `${file} was built at commit ${manifest.commit ?? '<none>'} (tag ${manifest.tag ?? '?'}), ` +
        `but DEPLOYMENT_COMMIT is ${commit}. Download the manifest for the release actually ` +
        `being deployed; a manifest from a different build proves nothing about these vkeys.`
    )
  }
  const builderImage = fs
    .readFileSync('zk/sp1-builder-image.txt', 'utf8')
    .trim()
  if (
    manifest.guest_build !== 'docker' ||
    manifest.builder_image !== builderImage
  ) {
    throw new Error(
      `${file} must describe guests built with the pinned Docker image ${builderImage}`
    )
  }

  const released = new Map(
    (manifest.programs ?? []).map((entry) => [entry.program, entry])
  )
  if (released.size !== manifest.programs?.length) {
    throw new Error(`${file} contains duplicate program entries`)
  }
  for (const entry of released.values()) {
    if (
      !entry.vkey ||
      !/^0x[0-9a-f]{64}$/i.test(entry.vkey) ||
      /^0x0{64}$/i.test(entry.vkey) ||
      !entry.elf_sha256 ||
      !/^[0-9a-f]{64}$/i.test(entry.elf_sha256) ||
      /^0{64}$/.test(entry.elf_sha256)
    ) {
      throw new Error(
        `${file} has an invalid vkey or ELF digest for ${entry.program ?? '<unnamed>'}`
      )
    }
  }

  // Every guest vkey this environment carries, whether or not this particular deploy path
  // consumes it. A weighted vkey that disagrees with the release is not harmless here: it is
  // evidence the environment is not the release's environment, and this is the one moment a
  // deploy looks at it.
  const pins: [string, string][] = [
    ['SP1_PROGRAM_VKEY', 'trust-graph'],
    ['SP1_WEIGHTED_PROGRAM_VKEY', 'trust-graph-weighted'],
    ['SP1_COMPOSITION_PROGRAM_VKEY', 'trust-compose'],
    ['SP1_SIGNER_PROGRAM_VKEY', 'signer-sync'],
    ['CONTRIBUTIONS_PROGRAM_VKEY', 'contributions'],
    ['NOSTR_WORKSPACE_VKEY', 'nostr-workspace'],
    ['HYPERCERTS_PROGRAM_VKEY', 'hypercerts'],
  ]

  for (const [name, program] of pins) {
    const pinned = process.env[name]
    if (!pinned) continue
    const entry = released.get(program)
    if (!entry?.vkey) {
      throw new Error(
        `${file} has no ${program} entry, so ${name} cannot be checked against the release.`
      )
    }
    if (hex(pinned) !== hex(entry.vkey)) {
      throw new Error(
        `${name} pins ${pinned}, but ${program} in the ${commit} release is ${entry.vkey}. ` +
          `A vkey that is not in the release is a local build: proofs from the released image ` +
          `will not verify against it, and the verifier fixes it at construction. Fix the pin ` +
          `before deploying — after deploying it costs a new verifier and a new factory.`
      )
    }
  }

  const trustGraph = released.get('trust-graph')
  const digest = requireReleaseDigest()
  if (!trustGraph?.elf_sha256 || hex(digest) !== hex(trustGraph.elf_sha256)) {
    throw new Error(
      `SP1_PROGRAM_ELF_SHA256 pins ${digest}, but trust-graph in the ${commit} release is ` +
        `${trustGraph?.elf_sha256 ?? '<missing>'}. The digest and the vkey describe the same ELF, so ` +
        `disagreement here means one of the two was copied from a different build.`
    )
  }
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
      case 'sepolia':
        if (stage !== 'production') break
        return new SepoliaEnv(overrides)
      case 'mainnet':
        if (stage !== 'production') break
        return new MainnetEnv(overrides)
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
      importedFactory: readJsonIfFileExists(
        '.docker/imported_factory_deploy.json'
      ),
      // One per chain: the frontend wizard calls this wrapper so a new instance, DAO Safe,
      // snapshot-specific Merkle governance, sealed owner guard, and delayed recovery module are
      // born in one transaction. The base factory remains the canonical event/catalog source.
      governedFactory: readJsonIfFileExists(
        '.docker/governed_factory_deploy.json'
      ),
      governedImportedFactory: readJsonIfFileExists(
        '.docker/governed_imported_factory_deploy.json'
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
        // REGISTRAR_ROLE on it so creating a network is permissionless *through the factory* while
        // rewriting an existing record stays with OPERATOR_ROLE. (This comment said OPERATOR_ROLE
        // until the role split landed; `DeployFactory` now asserts the factory does NOT hold it.)
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
        {
          name: 'Imported EAS Factory',
          script:
            'contracts/script/DeployImportedTrustgraphsFactory.s.sol:DeployImportedTrustgraphsFactory',
          sig: 'run(string,string,string,uint64,string)',
          args: () => [
            readJsonKey('.docker/eas_deploy.json', 'eas'),
            readJsonKey('.docker/zk_verifier_deploy.json', 'zk_verifier'),
            readJsonKey(
              '.docker/instance_registry_deploy.json',
              'instance_registry'
            ),
            process.env.FACTORY_EPOCH_FLOOR || '1',
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
        {
          name: 'Governed Imported EAS Factory',
          script:
            'contracts/script/DeployGovernedImportedTrustgraphsFactory.s.sol:DeployGovernedImportedTrustgraphsFactory',
          sig: 'run(string,string)',
          args: () => [
            readJsonKey(
              '.docker/imported_factory_deploy.json',
              'imported_factory'
            ),
            readJsonKey(
              '.docker/governed_factory_deploy.json',
              'governed_factory'
            ),
          ],
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
            'contracts/script/DeployGovernedProgramFactories.s.sol:DeployGovernedWeightedTrustgraphsFactory',
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
            'contracts/script/DeployGovernedProgramFactories.s.sol:DeployGovernedTrustComposeFactory',
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
            // The governance params. The factory derives `schema_uid`, `accumulator` and
            // `chain_id` itself — the file supplies only knobs.
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
        // The contributions ROUND factory. One per chain: the shared
        // contributions SP1JournalVerifier (CONTRIBUTIONS_PROGRAM_VKEY; unset = a nonzero dev
        // placeholder, valid only against the mock gateway), the controller deployer, the factory
        // (reusing the base factory's snapshot/distributor deployer singletons), and the
        // append-only registrar grant.
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

/**
 * Ethereum Sepolia public-release plan.
 *
 * The public testnet deliberately exposes every factory-backed program the hosted operator can
 * prove: trust-graph, weighted trust-graph, composition, contributions, and signer sync. Nostr
 * workspace instances remain a separate labeled pilot deployment because their immutable member
 * archive selection cannot be invented by a generic chain bootstrap. Hypercerts remains outside
 * the hosted operator's explicit scope fence.
 */
/**
 * One AccessControl grant the registry admin has to make after the broadcast, collected so the
 * whole set can be handed to a Safe as one Transaction Builder batch rather than typed in.
 */
type AdminGrant = {
  label: string
  contract: string
  role: string
  account: string
}

/**
 * The release plan for a public chain: the same ordered steps on every chain, parameterised by
 * `CHAIN_PROFILES[target]` (identity) and `PUBLIC_CHAIN_PLANS[target]` (which optional families
 * ship and which policy defaults hold). Nothing in here names a chain; adding one is a row in
 * each table plus a seed `deployments/<target>.json`.
 */
export class PublicChainEnv extends EnvBase {
  readonly releaseBase: ReleaseManifest
  readonly target: PublicChainTarget

  constructor(
    target: PublicChainTarget,
    {
      rpcUrl,
      ipfsGateway = 'https://gateway.pinata.cloud/ipfs/',
      newGeneration,
    }: EnvOverrides
  ) {
    const profile = CHAIN_PROFILES[target]
    const plan = PUBLIC_CHAIN_PLANS[target]
    const activeManifestFile = profile.releaseManifestFile
    if (!activeManifestFile) {
      throw new Error(`${profile.name} has no release manifest file`)
    }
    if (!rpcUrl) {
      throw new Error(
        `${profile.name} RPC URL is required (--rpc-url, RPC_URL, or ${profile.rpcEnv})`
      )
    }
    let parsedRpc: URL
    try {
      parsedRpc = new URL(rpcUrl)
    } catch {
      throw new Error(`${profile.name} RPC URL must be an absolute http(s) URL`)
    }
    if (!['http:', 'https:'].includes(parsedRpc.protocol)) {
      throw new Error(`${profile.name} RPC URL must use http or https`)
    }
    const activeManifest = loadReleaseManifest(activeManifestFile, {
      expectedChain: target,
    })
    if (newGeneration) requireReleaseVkeys()
    const manifest = newGeneration
      ? planGeneration(
          activeManifest,
          JSON.parse(
            fs.readFileSync(
              process.env.GUEST_MANIFEST || 'guest-manifest.json',
              'utf8'
            )
          ),
          requireReleaseCommit()
        )
      : activeManifest
    const continuing = (ctx: ProgramContext): boolean =>
      Boolean(ctx.options.continueExisting)
    const skipExisting =
      (key: keyof ReleaseManifest['contracts']) => (ctx: ProgramContext) =>
        continuing(ctx) && Boolean(manifest.contracts[key]?.address)
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
    const programDelay = (name: string): string => {
      const value = process.env[name] || '86400'
      if (!/^[1-9][0-9]*$/.test(value) || BigInt(value) < 86_400n) {
        throw new Error(
          `${name} must be at least 86400 seconds on ${profile.name}`
        )
      }
      return value
    }
    const adminAddress = () =>
      requiredAddress(
        'INSTANCE_REGISTRY_ADMIN',
        process.env.INSTANCE_REGISTRY_ADMIN
      )
    // Grants only the registry admin can make, collected as the steps print them.
    const adminGrants: AdminGrant[] = []
    const artifactAddresses: Partial<
      Record<keyof ReleaseManifest['contracts'], [string, string]>
    > = {
      schemaRegistrar: ['eas', 'schema_registrar'],
      rootVerifier: ['zk_verifier', 'zk_verifier'],
      instanceRegistry: ['instance_registry', 'instance_registry'],
      provingVault: ['proving_vault', 'proving_vault'],
      trustgraphsFactory: ['factory', 'factory'],
      importedTrustgraphsFactory: ['imported_factory', 'imported_factory'],
      signerVerifier: ['zk_verifier_signer', 'zk_verifier'],
      governedTrustgraphsFactory: ['governed_factory', 'governed_factory'],
      weightedVerifier: ['zk_verifier_weighted', 'zk_verifier'],
      weightedTrustgraphsFactory: ['weighted_factory', 'weighted_factory'],
      compositionVerifier: ['zk_verifier_composition', 'zk_verifier'],
      trustComposeFactory: ['trust_compose_factory', 'trust_compose_factory'],
      subnetworkRegistry: ['governed_factory', 'subnetwork_registry'],
    }
    const existingAddress = (
      key: keyof ReleaseManifest['contracts']
    ): string => {
      const artifact = artifactAddresses[key]
      return requiredAddress(
        `deployment.contracts.${key}`,
        manifest.contracts[key]?.address ||
          (artifact
            ? readJsonKeyIfFileExists<string>(
                `.docker/${artifact[0]}_deploy.json`,
                artifact[1]
              )
            : undefined)
      )
    }
    const registrarGrant = (label: string, file: string, key: string) => () => {
      const factory = readJsonKeyIfFileExists<string>(file, key) || `<${label}>`
      const registry =
        manifest.contracts.instanceRegistry.address ||
        readJsonKeyIfFileExists<string>(
          '.docker/instance_registry_deploy.json',
          'instance_registry'
        ) ||
        '<InstanceRegistry>'
      const admin = process.env.INSTANCE_REGISTRY_ADMIN || '<registry admin>'
      if (factory.startsWith('0x') && registry.startsWith('0x')) {
        adminGrants.push({
          label: `${label}: REGISTRAR_ROLE on InstanceRegistry`,
          contract: registry,
          role: 'REGISTRAR_ROLE',
          account: factory,
        })
      }
      console.log(
        [
          '',
          `${label} is deployed but cannot register instances until the registry admin grants its append-only role.`,
          `Signed by ${admin}:`,
          '',
          `  cast send ${registry} 'grantRole(bytes32,address)' \\`,
          `    $(cast keccak 'REGISTRAR_ROLE') ${factory} \\`,
          '    --rpc-url "$RPC_URL" --private-key <the registry admin key>',
          '',
          `  cast call ${registry} 'hasRole(bytes32,address)(bool)' \\`,
          `    $(cast keccak 'REGISTRAR_ROLE') ${factory} --rpc-url "$RPC_URL"   # -> true`,
          `  cast call ${registry} 'hasRole(bytes32,address)(bool)' \\`,
          `    $(cast keccak 'OPERATOR_ROLE') ${factory} --rpc-url "$RPC_URL"    # -> false`,
          '',
        ].join('\n')
      )
    }
    const vaultEnvironment = () => {
      const feed = requiredAddress(
        'ETH_USD_FEED',
        process.env.ETH_USD_FEED || manifest.external.ethUsdFeed
      )
      const usdc = requiredAddress(
        'USDC',
        process.env.USDC || manifest.external.usdc
      )
      // Per chain, from the plan table. Sepolia's Chainlink ETH/USD feed is slower and less
      // regular than mainnet's, so the off-devnet default in DeployProvingVault (5400s = a mainnet
      // hourly heartbeat plus 50% grace) is too tight there. Measured over 15.5h of round history
      // on 2026-08-23: mean gap 2929s, worst gap 3696s, and the live answer was already 3348s old
      // when sampled. 5400 would leave under half an hour of headroom, so one skipped heartbeat
      // silently drops the proving fee to zero. 7200 is roughly twice the observed worst gap. The
      // failure is benign either way (a stale answer pays no fee and still lands the root), but on
      // the tighter window a rehearsal would read zero fees often enough to look like a bug.
      // Mainnet keeps the script default.
      const feedMaxStaleness =
        process.env.FEED_MAX_STALENESS || plan.feedMaxStaleness
      return {
        ETH_USD_FEED: feed,
        USDC: usdc,
        FEED_MAX_STALENESS: feedMaxStaleness,
      }
    }

    super({
      stage: 'production',
      profile: {
        ...profile,
        releaseManifestFile: newGeneration
          ? generationManifestPath(newGeneration, target)
          : activeManifestFile,
      },
      rpcUrl,
      registry: process.env.SERVICE_REGISTRY_URL || '',
      serviceName: 'trust-graph',
      triggerChain: `evm:${profile.chainId}`,
      submitChain: `evm:${profile.chainId}`,
      ipfs: {
        pinApi: 'https://uploads.pinata.cloud/v3/files',
        gateway: ipfsGateway,
      },
      networksConfigFile: `config/networks.${target}.json`,
      validateDeployment: () => {
        if (newGeneration && process.env.SKIP_PROVING_VAULT === 'true') {
          throw new Error(
            `A new hosted ${profile.name} generation requires its own ProvingVault`
          )
        }
        requireReleaseCommit()
        requireReleaseDigest()
        requireReleaseVkeys()
        gateway()
        requireProdBytes32('SP1_PROGRAM_VKEY')
        requireProdBytes32('SP1_SIGNER_PROGRAM_VKEY')
        requireProgramVkey('SP1_WEIGHTED_PROGRAM_VKEY', 'trust-graph-weighted')
        requireProgramVkey('SP1_COMPOSITION_PROGRAM_VKEY', 'trust-compose')
        requireProgramVkey('CONTRIBUTIONS_PROGRAM_VKEY', 'contributions')
        adminAddress()
        // The factory scripts refuse a floor under ~1 day of blocks on a real chain unless the
        // chain's own opt-in is set. Attempt 2 of v0.1.0 (2026-09-09) broadcast four contracts
        // before step 5 hit that guard; this catches it at zero transactions, and in a dry run.
        const floor = BigInt(requireProdUint64('FACTORY_EPOCH_FLOOR'))
        if (
          floor < DELIBERATE_EPOCH_FLOOR &&
          process.env[plan.epochFloorOptIn] !== 'true'
        ) {
          throw new Error(
            `FACTORY_EPOCH_FLOOR=${floor} is below ${DELIBERATE_EPOCH_FLOOR} blocks; the factory ` +
              `scripts refuse it on ${profile.name} unless ${plan.epochFloorOptIn}=true is set deliberately`
          )
        }
        programDelay('WEIGHTED_PRIOR_ACTIVATION_DELAY')
        programDelay('COMPOSE_POLICY_ACTIVATION_DELAY')
        if (process.env.SKIP_PROVING_VAULT !== 'true') vaultEnvironment()
      },
      deployContracts: [
        {
          name: 'Schema Registrar (canonical EAS)',
          script: 'contracts/script/DeployEAS.s.sol:DeployEAS',
          sig: 'run(string,string)',
          args: () => [manifest.external.eas, manifest.external.schemaRegistry],
          skip: skipExisting('schemaRegistrar'),
        },
        {
          name: 'Trust-graph ZK Verifier',
          script: 'contracts/script/DeployZkVerifier.s.sol:DeployZkVerifier',
          sig: 'run(string,bytes32,string)',
          args: () => [gateway(), requireProdBytes32('SP1_PROGRAM_VKEY'), ''],
          skip: skipExisting('rootVerifier'),
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
          skip: skipExisting('instanceRegistry'),
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
          skip: (ctx) =>
            skipExisting('provingVault')(ctx) ||
            process.env.SKIP_PROVING_VAULT === 'true',
          // `DeployProvingVault` hardcodes the DEPLOYER as both DEFAULT_ADMIN_ROLE and
          // FEE_SETTER_ROLE because it prices the fee schedule in the same run. The plan's
          // penultimate step, `Hand off Proving Vault`, moves both roles to the admin and proves
          // the deployer holds neither; nothing is left for a human to remember.
        },
        {
          name: 'Trustgraphs Factory',
          script: 'contracts/script/DeployFactory.s.sol:DeployFactory',
          sig: 'run(string,string,string,string,uint64,string)',
          // The factory's REGISTRAR_ROLE grant is NOT made here, and the reason is the custody
          // shape this deployment is rehearsing. `DeployFactory` grants by default, signed by the
          // deployer, on the assumption stated in its own natspec: "the registry's admin key,
          // which at bootstrap is the deployer". That assumption does not hold here. Sepolia
          // deploys the registry with `INSTANCE_REGISTRY_ADMIN` as its admin from birth, so the
          // deployer never holds DEFAULT_ADMIN_ROLE and `grantRole` reverts
          // AccessControlUnauthorizedAccount — measured on anvil, deployer vs. a separate admin,
          // selector 0xe2517d3f. Step 5 of 5 would fail after the first four had landed.
          //
          // Bootstrapping the registry to the deployer and transferring afterwards would make the
          // grant work, and is the wrong trade: it puts the whole directory under the deploy
          // machine's key for the length of the deploy, which is exactly the window mainnet must
          // not have. So the grant becomes what it will be on mainnet — a separate action by the
          // registry's admin — and `postRun` prints it rather than leaving it to be discovered
          // when the first network creation reverts. Same choice research/operations/production.md
          // already documents.
          env: () => ({ GRANT_REGISTRAR: 'false' }),
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
          skip: skipExisting('trustgraphsFactory'),
          // Printed, not enforced. Nothing in here may throw: it runs after the last contract has
          // landed but BEFORE the release manifest is written, so an exception raised while
          // formatting an instruction would cost the record of a deploy that actually succeeded.
          postRun: () => {
            const registry =
              readJsonIfFileExists<Record<string, string>>(
                '.docker/instance_registry_deploy.json'
              )?.instance_registry ?? '<InstanceRegistry>'
            const factory =
              readJsonIfFileExists<Record<string, string>>(
                '.docker/factory_deploy.json'
              )?.factory ?? '<TrustgraphsFactory>'
            const admin = process.env.INSTANCE_REGISTRY_ADMIN ?? '<the admin>'
            if (factory.startsWith('0x') && registry.startsWith('0x')) {
              adminGrants.push({
                label: 'TrustgraphsFactory: REGISTRAR_ROLE on InstanceRegistry',
                contract: registry,
                role: 'REGISTRAR_ROLE',
                account: factory,
              })
            }
            console.log(
              [
                '',
                "ONE STEP REMAINS, and it is not the deployer's to take.",
                '',
                'The factory is deployed but cannot yet register anything: REGISTRAR_ROLE was',
                'deliberately not granted, because only the registry admin can grant it. Until',
                `it is, every network creation reverts. Signed by ${admin}:`,
                '',
                `  cast send ${registry} \\`,
                "    'grantRole(bytes32,address)' \\",
                `    $(cast keccak 'REGISTRAR_ROLE') ${factory} \\`,
                '    --rpc-url "$RPC_URL" --private-key <the admin key, however you hold it>',
                '',
                'Then confirm it, rather than assuming the send landed:',
                '',
                `  cast call ${registry} 'hasRole(bytes32,address)(bool)' \\`,
                `    $(cast keccak 'REGISTRAR_ROLE') ${factory} --rpc-url "$RPC_URL"   # -> true`,
                `  cast call ${registry} 'hasRole(bytes32,address)(bool)' \\`,
                `    $(cast keccak 'OPERATOR_ROLE') ${factory} --rpc-url "$RPC_URL"    # -> false`,
                '',
                'The second one matters as much as the first: OPERATOR_ROLE would let the factory',
                'rewrite existing records, not just append its own.',
                '',
              ].join('\n')
            )
          },
        },
        {
          name: 'Imported EAS Factory',
          script:
            'contracts/script/DeployImportedTrustgraphsFactory.s.sol:DeployImportedTrustgraphsFactory',
          sig: 'run(string,string,string,uint64,string)',
          env: () => ({ GRANT_REGISTRAR: 'false' }),
          args: () => [
            manifest.external.eas,
            existingAddress('rootVerifier'),
            existingAddress('instanceRegistry'),
            requireProdUint64('FACTORY_EPOCH_FLOOR'),
            process.env.SKIP_PROVING_VAULT === 'true'
              ? ''
              : existingAddress('provingVault'),
          ],
          skip: (ctx) =>
            !plan.importedEasFamily ||
            (continuing(ctx) &&
              manifest.contracts.importedTrustgraphsFactory?.address != null),
          postRun: registrarGrant(
            'ImportedTrustgraphsFactory',
            '.docker/imported_factory_deploy.json',
            'imported_factory'
          ),
        },
        {
          name: 'Signer ZK Verifier',
          script: 'contracts/script/DeployZkVerifier.s.sol:DeployZkVerifier',
          sig: 'run(string,bytes32,string)',
          args: () => [
            gateway(),
            requireProdBytes32('SP1_SIGNER_PROGRAM_VKEY'),
            'signer',
          ],
          skip: skipExisting('signerVerifier'),
        },
        {
          name: 'Governed Factory',
          script:
            'contracts/script/DeployGovernedTrustgraphsFactory.s.sol:DeployGovernedTrustgraphsFactory',
          sig: 'run(string,string,bytes32,string,string)',
          args: () => [
            existingAddress('trustgraphsFactory'),
            existingAddress('signerVerifier'),
            requireProdBytes32('SP1_SIGNER_PROGRAM_VKEY'),
            requiredAddress(
              'manifest.contracts.safeSingleton.address',
              manifest.contracts.safeSingleton.address
            ),
            requiredAddress(
              'manifest.contracts.safeProxyFactory.address',
              manifest.contracts.safeProxyFactory.address
            ),
          ],
          skip: (ctx) =>
            continuing(ctx) &&
            manifest.contracts.governedTrustgraphsFactory.address !== null &&
            manifest.contracts.signerSyncModuleDeployer.address !== null,
        },
        {
          name: 'Governed Imported EAS Factory',
          script:
            'contracts/script/DeployGovernedImportedTrustgraphsFactory.s.sol:DeployGovernedImportedTrustgraphsFactory',
          sig: 'run(string,string)',
          args: () => [
            existingAddress('importedTrustgraphsFactory'),
            existingAddress('governedTrustgraphsFactory'),
          ],
          skip: (ctx) =>
            !plan.importedEasFamily ||
            (continuing(ctx) &&
              manifest.contracts.governedImportedTrustgraphsFactory?.address !=
                null),
        },
        {
          name: 'Weighted ZK Verifier',
          script: 'contracts/script/DeployZkVerifier.s.sol:DeployZkVerifier',
          sig: 'run(string,bytes32,string)',
          args: () => [
            gateway(),
            requireProgramVkey(
              'SP1_WEIGHTED_PROGRAM_VKEY',
              'trust-graph-weighted'
            ),
            'weighted',
          ],
          skip: skipExisting('weightedVerifier'),
        },
        {
          name: 'Weighted Factory',
          script:
            'contracts/script/DeployWeightedTrustgraphsFactory.s.sol:DeployWeightedTrustgraphsFactory',
          sig: 'run(string,string,string,string,uint64,uint48,string)',
          env: () => ({ GRANT_REGISTRAR: 'false' }),
          args: () => [
            manifest.external.eas,
            existingAddress('schemaRegistrar'),
            readJsonKey(
              '.docker/zk_verifier_weighted_deploy.json',
              'zk_verifier'
            ),
            existingAddress('instanceRegistry'),
            requireProdUint64('FACTORY_EPOCH_FLOOR'),
            programDelay('WEIGHTED_PRIOR_ACTIVATION_DELAY'),
            existingAddress('provingVault'),
          ],
          skip: skipExisting('weightedTrustgraphsFactory'),
          postRun: registrarGrant(
            'WeightedTrustgraphsFactory',
            '.docker/weighted_factory_deploy.json',
            'weighted_factory'
          ),
        },
        {
          name: 'Governed Weighted Factory',
          script:
            'contracts/script/DeployGovernedProgramFactories.s.sol:DeployGovernedWeightedTrustgraphsFactory',
          sig: 'run(string,string)',
          args: () => [
            readJsonKey(
              '.docker/weighted_factory_deploy.json',
              'weighted_factory'
            ),
            existingAddress('governedTrustgraphsFactory'),
          ],
          skip: skipExisting('governedWeightedTrustgraphsFactory'),
        },
        {
          name: 'Composition ZK Verifier',
          script: 'contracts/script/DeployZkVerifier.s.sol:DeployZkVerifier',
          sig: 'run(string,bytes32,string)',
          args: () => [
            gateway(),
            requireProgramVkey('SP1_COMPOSITION_PROGRAM_VKEY', 'trust-compose'),
            'composition',
          ],
          skip: skipExisting('compositionVerifier'),
        },
        {
          name: 'Trust Compose Factory',
          script:
            'contracts/script/DeployTrustComposeFactory.s.sol:DeployTrustComposeFactory',
          sig: 'run(string,bytes32,string,uint64,uint48,string)',
          env: () => ({ GRANT_REGISTRAR: 'false' }),
          args: () => [
            readJsonKey(
              '.docker/zk_verifier_composition_deploy.json',
              'zk_verifier'
            ),
            requireProgramVkey('SP1_COMPOSITION_PROGRAM_VKEY', 'trust-compose'),
            existingAddress('instanceRegistry'),
            requireProdUint64('FACTORY_EPOCH_FLOOR'),
            programDelay('COMPOSE_POLICY_ACTIVATION_DELAY'),
            existingAddress('provingVault'),
          ],
          skip: skipExisting('trustComposeFactory'),
          postRun: registrarGrant(
            'TrustComposeFactory',
            '.docker/trust_compose_factory_deploy.json',
            'trust_compose_factory'
          ),
        },
        {
          name: 'Governed Compose Factory',
          script:
            'contracts/script/DeployGovernedProgramFactories.s.sol:DeployGovernedTrustComposeFactory',
          sig: 'run(string,string)',
          args: () => [
            readJsonKey(
              '.docker/trust_compose_factory_deploy.json',
              'trust_compose_factory'
            ),
            existingAddress('governedTrustgraphsFactory'),
          ],
          skip: skipExisting('governedTrustComposeFactory'),
        },
        {
          name: 'Contributions Factory',
          script:
            'contracts/script/DeployContributionsFactory.s.sol:DeployContributionsFactory',
          sig: 'run(string,string,string,string,string,uint64)',
          env: () => ({
            GRANT_REGISTRAR: 'false',
            CONTRIBUTIONS_PROGRAM_VKEY: requireProgramVkey(
              'CONTRIBUTIONS_PROGRAM_VKEY',
              'contributions'
            ),
          }),
          args: () => [
            manifest.external.eas,
            existingAddress('schemaRegistrar'),
            gateway(),
            existingAddress('instanceRegistry'),
            existingAddress('trustgraphsFactory'),
            requireProdUint64('FACTORY_EPOCH_FLOOR'),
          ],
          skip: skipExisting('contributionsFactory'),
          postRun: registrarGrant(
            'ContributionsFactory',
            '.docker/contributions_factory_deploy.json',
            'contributions_factory'
          ),
        },
        // The two contracts the deployer administers during the run and must not keep. The vault
        // priced its fee schedule with the deployer's FEE_SETTER_ROLE; the subnetwork registry
        // took REGISTRAR_ROLE grants for the governed weighted and compose wrappers with the
        // deployer's DEFAULT_ADMIN_ROLE. Both hand over in one broadcast each, with the script
        // asserting the end state from chain rather than trusting the send.
        {
          name: 'Hand off Proving Vault',
          script:
            'contracts/script/HandoffAccessControl.s.sol:HandoffAccessControl',
          sig: 'run(string,string,string)',
          args: () => [
            existingAddress('provingVault'),
            adminAddress(),
            'DEFAULT_ADMIN_ROLE,FEE_SETTER_ROLE',
          ],
          skip: (ctx) =>
            skipExisting('provingVault')(ctx) ||
            process.env.SKIP_PROVING_VAULT === 'true',
        },
        {
          name: 'Hand off Subnetwork Registry',
          script:
            'contracts/script/HandoffAccessControl.s.sol:HandoffAccessControl',
          sig: 'run(string,string,string)',
          args: () => [
            existingAddress('subnetworkRegistry'),
            adminAddress(),
            'DEFAULT_ADMIN_ROLE',
          ],
          skip: (ctx) =>
            continuing(ctx) &&
            manifest.contracts.subnetworkRegistry?.address != null,
        },
      ],
      // The grants only the registry admin can make, as one Safe Transaction Builder batch. Not a
      // secret and not a manifest: it is scratch output next to the other receipts. Never throws;
      // the manifest write that follows must not be lost to a formatting error here.
      postDeployContracts: () => {
        if (adminGrants.length === 0) return
        try {
          const file = `.docker/admin-grants.${target}.json`
          fs.writeFileSync(
            file,
            `${JSON.stringify(safeTransactionBatch(profile.chainId, adminGrants), null, 2)}\n`
          )
          console.log(
            [
              '',
              `${adminGrants.length} grant(s) remain for the registry admin. They are written as a Safe`,
              `Transaction Builder batch to ${file}; import it in the Safe app, or send them one by one:`,
              ...adminGrants.map(
                (grant) =>
                  `  ${grant.label}: grantRole(${grant.role}, ${grant.account}) on ${grant.contract}`
              ),
              '',
            ].join('\n')
          )
        } catch (error) {
          console.log(`Could not write the admin grant batch: ${String(error)}`)
        }
      },
    })
    this.releaseBase = manifest
    this.target = target
  }

  generateReleaseManifest(ctx?: ProgramContext): object {
    const base = this.releaseBase
    const continuing = Boolean(ctx?.options.continueExisting)
    const broadcasts = readBroadcastDeployments('.', this.profile.chainId)
    // A continuation treats the tracked manifest as the sole source of truth for the original
    // five contracts. `.docker` is shared with local Anvil runs and may contain perfectly valid
    // artifacts for a different chain; reading it here would defeat the address-preservation gate
    // after the two additive transactions had already landed.
    const eas = continuing
      ? null
      : readJsonIfFileExists<Record<string, string>>('.docker/eas_deploy.json')
    const verifier = continuing
      ? null
      : readJsonIfFileExists<Record<string, string>>(
          '.docker/zk_verifier_deploy.json'
        )
    const registry = continuing
      ? null
      : readJsonIfFileExists<Record<string, string>>(
          '.docker/instance_registry_deploy.json'
        )
    const vault =
      continuing || process.env.SKIP_PROVING_VAULT === 'true'
        ? null
        : readJsonIfFileExists<Record<string, string>>(
            '.docker/proving_vault_deploy.json'
          )
    const factory = continuing
      ? null
      : readJsonIfFileExists<Record<string, string>>(
          '.docker/factory_deploy.json'
        )
    const signerVerifier = base.contracts.signerVerifier.address
      ? null
      : readJsonIfFileExists<Record<string, string>>(
          '.docker/zk_verifier_signer_deploy.json'
        )
    const governedFactory = base.contracts.governedTrustgraphsFactory.address
      ? null
      : readJsonIfFileExists<Record<string, string>>(
          '.docker/governed_factory_deploy.json'
        )
    const importedFactory = base.contracts.importedTrustgraphsFactory?.address
      ? null
      : readJsonIfFileExists<Record<string, string>>(
          '.docker/imported_factory_deploy.json'
        )
    const governedImportedFactory = base.contracts
      .governedImportedTrustgraphsFactory?.address
      ? null
      : readJsonIfFileExists<Record<string, string>>(
          '.docker/governed_imported_factory_deploy.json'
        )
    const additiveArtifact = (
      key: keyof ReleaseManifest['contracts'],
      file: string
    ): Record<string, string> | null =>
      base.contracts[key]?.address
        ? null
        : readJsonIfFileExists<Record<string, string>>(file) || null
    const weightedVerifier = additiveArtifact(
      'weightedVerifier',
      '.docker/zk_verifier_weighted_deploy.json'
    )
    const weightedFactory = additiveArtifact(
      'weightedTrustgraphsFactory',
      '.docker/weighted_factory_deploy.json'
    )
    const governedWeightedFactory = additiveArtifact(
      'governedWeightedTrustgraphsFactory',
      '.docker/governed_weighted_factory_deploy.json'
    )
    const compositionVerifier = additiveArtifact(
      'compositionVerifier',
      '.docker/zk_verifier_composition_deploy.json'
    )
    const composeFactory = additiveArtifact(
      'trustComposeFactory',
      '.docker/trust_compose_factory_deploy.json'
    )
    const governedComposeFactory = additiveArtifact(
      'governedTrustComposeFactory',
      '.docker/governed_compose_factory_deploy.json'
    )
    const contributionsFactory = additiveArtifact(
      'contributionsFactory',
      '.docker/contributions_factory_deploy.json'
    )

    // `.docker/*_deploy.json` is a scratch directory shared with every local anvil run, and it is
    // gitignored, so it routinely holds yesterday's dev stack. In a clean full run each step
    // overwrites its file before the next reads it and none of that matters. It matters if a run
    // is resumed, or if a step is skipped: the vkey below would then be whatever the last LOCAL
    // deploy wrote, and `validateReleaseManifest` would not object, because it only checks that a
    // vkey is well-formed bytes32 and present. A locally-built guest has a perfectly well-formed
    // vkey — it is simply a property of the machine that built it, and pinning it is the one
    // mistake this whole reproducible-build chain exists to prevent.
    //
    // So the manifest asserts identity with the vkey the verifier was DEPLOYED against, rather
    // than trusting the file it was read from to be fresh.
    const deployedVkey = verifier?.program_vkey
    const expectedVkey = process.env.SP1_PROGRAM_VKEY
    if (
      deployedVkey &&
      expectedVkey &&
      deployedVkey.toLowerCase() !== expectedVkey.toLowerCase()
    ) {
      throw new Error(
        `.docker/zk_verifier_deploy.json records vkey ${deployedVkey}, but this deployment ` +
          `pinned SP1_PROGRAM_VKEY=${expectedVkey}. That file is stale — almost certainly from a ` +
          `local anvil run. Clear .docker/*_deploy.json and redeploy; do not write this manifest.`
      )
    }
    for (const [artifact, file, envName] of [
      [
        weightedVerifier,
        '.docker/zk_verifier_weighted_deploy.json',
        'SP1_WEIGHTED_PROGRAM_VKEY',
      ],
      [
        compositionVerifier,
        '.docker/zk_verifier_composition_deploy.json',
        'SP1_COMPOSITION_PROGRAM_VKEY',
      ],
      [
        contributionsFactory,
        '.docker/contributions_factory_deploy.json',
        'CONTRIBUTIONS_PROGRAM_VKEY',
      ],
    ] as const) {
      const deployed = artifact?.program_vkey
      const expected = process.env[envName]
      if (
        deployed &&
        expected &&
        deployed.toLowerCase() !== expected.toLowerCase()
      ) {
        throw new Error(
          `${file} records vkey ${deployed}, but this deployment pins ${envName}=${expected}. ` +
            'Refusing to write the public manifest.'
        )
      }
    }
    const deployedSignerVkey = signerVerifier?.program_vkey
    const expectedSignerVkey = process.env.SP1_SIGNER_PROGRAM_VKEY
    if (
      deployedSignerVkey &&
      expectedSignerVkey &&
      deployedSignerVkey.toLowerCase() !== expectedSignerVkey.toLowerCase()
    ) {
      throw new Error(
        `.docker/zk_verifier_signer_deploy.json records vkey ${deployedSignerVkey}, but this ` +
          `deployment pins SP1_SIGNER_PROGRAM_VKEY=${expectedSignerVkey}. Refusing to write the manifest.`
      )
    }
    for (const [artifactKey, manifestKey] of [
      ['safe_singleton', 'safeSingleton'],
      ['safe_factory', 'safeProxyFactory'],
    ] as const) {
      const deployed = governedFactory?.[artifactKey]
      const expected = base.contracts[manifestKey].address
      if (
        deployed &&
        expected &&
        deployed.toLowerCase() !== expected.toLowerCase()
      ) {
        throw new Error(
          `Governed factory used ${artifactKey}=${deployed}, expected canonical ${expected}`
        )
      }
    }

    const mergedRecord = (
      address: string | undefined,
      existing: DeploymentRecord
    ): DeploymentRecord =>
      address ? deploymentRecord(address, broadcasts) : existing
    const emptyRecord: DeploymentRecord = {
      address: null,
      block: null,
      txHash: null,
    }
    const contracts = {
      schemaRegistrar: mergedRecord(
        eas?.schema_registrar,
        base.contracts.schemaRegistrar
      ),
      rootVerifier: mergedRecord(
        verifier?.zk_verifier,
        base.contracts.rootVerifier
      ),
      instanceRegistry: mergedRecord(
        registry?.instance_registry,
        base.contracts.instanceRegistry
      ),
      provingVault: mergedRecord(
        vault?.proving_vault,
        base.contracts.provingVault
      ),
      trustgraphsFactory: mergedRecord(
        factory?.factory,
        base.contracts.trustgraphsFactory
      ),
      importedTrustgraphsFactory: mergedRecord(
        importedFactory?.imported_factory,
        base.contracts.importedTrustgraphsFactory ?? emptyRecord
      ),
      signerVerifier: mergedRecord(
        signerVerifier?.zk_verifier,
        base.contracts.signerVerifier
      ),
      governedTrustgraphsFactory: mergedRecord(
        governedFactory?.governed_factory,
        base.contracts.governedTrustgraphsFactory
      ),
      governedImportedTrustgraphsFactory: mergedRecord(
        governedImportedFactory?.governed_imported_factory,
        base.contracts.governedImportedTrustgraphsFactory ?? emptyRecord
      ),
      signerSyncModuleDeployer: mergedRecord(
        governedFactory?.signer_sync_deployer,
        base.contracts.signerSyncModuleDeployer
      ),
      parentAuthorityModuleDeployer: mergedRecord(
        governedFactory?.parent_authority_deployer,
        base.contracts.parentAuthorityModuleDeployer ?? emptyRecord
      ),
      subnetworkRegistry: mergedRecord(
        governedFactory?.subnetwork_registry,
        base.contracts.subnetworkRegistry ?? emptyRecord
      ),
      safeSingleton: {
        ...base.contracts.safeSingleton,
        address:
          (governedFactory?.safe_singleton as Hex | undefined) ||
          base.contracts.safeSingleton.address,
      },
      safeProxyFactory: {
        ...base.contracts.safeProxyFactory,
        address:
          (governedFactory?.safe_factory as Hex | undefined) ||
          base.contracts.safeProxyFactory.address,
      },
      weightedVerifier: mergedRecord(
        weightedVerifier?.zk_verifier,
        base.contracts.weightedVerifier
      ),
      weightedTrustgraphsFactory: mergedRecord(
        weightedFactory?.weighted_factory,
        base.contracts.weightedTrustgraphsFactory
      ),
      governedWeightedTrustgraphsFactory: mergedRecord(
        governedWeightedFactory?.governed_weighted_factory,
        base.contracts.governedWeightedTrustgraphsFactory
      ),
      compositionVerifier: mergedRecord(
        compositionVerifier?.zk_verifier,
        base.contracts.compositionVerifier
      ),
      trustComposeFactory: mergedRecord(
        composeFactory?.trust_compose_factory,
        base.contracts.trustComposeFactory
      ),
      governedTrustComposeFactory: mergedRecord(
        governedComposeFactory?.governed_compose_factory,
        base.contracts.governedTrustComposeFactory
      ),
      contributionsVerifier: mergedRecord(
        contributionsFactory?.zk_verifier,
        base.contracts.contributionsVerifier
      ),
      contributionsFactory: mergedRecord(
        contributionsFactory?.contributions_factory,
        base.contracts.contributionsFactory
      ),
    }
    if (!PUBLIC_CHAIN_PLANS[this.target].importedEasFamily) {
      // Not part of this chain's generation: absent, not null, so a reader cannot mistake "never
      // deployed here" for "deployed and half recorded".
      delete (contracts as Partial<typeof contracts>).importedTrustgraphsFactory
      delete (contracts as Partial<typeof contracts>)
        .governedImportedTrustgraphsFactory
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
          verifier?.sp1_gateway ||
          process.env.SP1_VERIFIER_GATEWAY ||
          base.external.sp1Gateway,
        ethUsdFeed: vault?.eth_usd_feed || base.external.ethUsdFeed,
        usdc: vault?.usdc || base.external.usdc,
      },
      contracts,
      programs: {
        ...base.programs,
        trustGraph: {
          ...base.programs.trustGraph,
          elfSha256: requireReleaseDigest(),
          vkey: verifier?.program_vkey || base.programs.trustGraph.vkey,
        },
        signer: {
          ...base.programs.signer,
          vkey:
            signerVerifier?.program_vkey || base.programs.signer.vkey || null,
        },
        weighted: {
          ...base.programs.weighted,
          vkey:
            weightedVerifier?.program_vkey ||
            base.programs.weighted.vkey ||
            null,
        },
        composition: {
          ...base.programs.composition,
          vkey:
            compositionVerifier?.program_vkey ||
            base.programs.composition.vkey ||
            null,
        },
        contributions: {
          ...base.programs.contributions,
          vkey:
            contributionsFactory?.program_vkey ||
            base.programs.contributions.vkey ||
            null,
        },
      },
    }
    return validateReleaseManifest(manifest, {
      requireComplete: true,
      expectedChain: this.target,
    })
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

export class SepoliaEnv extends PublicChainEnv {
  constructor(overrides: EnvOverrides = {}) {
    super('sepolia', overrides)
  }
}

export class MainnetEnv extends PublicChainEnv {
  constructor(overrides: EnvOverrides = {}) {
    super('mainnet', overrides)
  }
}

const GRANT_ROLE_ABI = [
  {
    type: 'function',
    name: 'grantRole',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'role', type: 'bytes32', internalType: 'bytes32' },
      { name: 'account', type: 'address', internalType: 'address' },
    ],
    outputs: [],
  },
] as const

/** OpenZeppelin's DEFAULT_ADMIN_ROLE is the zero hash, not the keccak of its name. */
const roleHash = (role: string): Hex =>
  role === 'DEFAULT_ADMIN_ROLE'
    ? `0x${'0'.repeat(64)}`
    : keccak256(toBytes(role))

/**
 * The Safe Transaction Builder's batch format, so a multisig admin imports the grants instead
 * of retyping them. `data` is included as well for anyone sending them another way.
 */
export const safeTransactionBatch = (chainId: number, grants: AdminGrant[]) => ({
  version: '1.0',
  chainId: String(chainId),
  createdAt: Date.now(),
  meta: {
    name: 'Trustgraphs registry admin grants',
    description: grants.map((grant) => grant.label).join('; '),
    txBuilderVersion: '1.17.1',
    createdFromSafeAddress: '',
    createdFromOwnerAddress: '',
  },
  transactions: grants.map((grant) => ({
    to: grant.contract,
    value: '0',
    data: encodeFunctionData({
      abi: GRANT_ROLE_ABI,
      functionName: 'grantRole',
      args: [roleHash(grant.role), grant.account as Hex],
    }),
    contractMethod: {
      inputs: GRANT_ROLE_ABI[0].inputs.map((input) => ({ ...input })),
      name: 'grantRole',
      payable: false,
    },
    contractInputsValues: {
      role: roleHash(grant.role),
      account: grant.account,
    },
  })),
})

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
  program.parse(process.argv)

  const options = program.opts()
  const dotenv = loadDotenv(options.chain)
  const selection = resolveDeploymentSelection({
    stage: options.stage || process.env.DEPLOY_STAGE,
    target: options.chain || process.env.DEPLOY_TARGET,
  })
  if (options.newGeneration !== undefined) {
    if (selection.target === 'local' || options.continueExisting) {
      throw new Error(
        '--new-generation requires a public chain target and cannot be combined with --continue-existing'
      )
    }
    generationManifestPath(options.newGeneration, selection.target)
  }
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
