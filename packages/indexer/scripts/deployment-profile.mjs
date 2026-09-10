import fs from 'node:fs'
import path from 'node:path'

const ADDRESS = /^0x[0-9a-f]{40}$/i
const BYTES32 = /^0x[0-9a-f]{64}$/i
const COMMIT = /^[0-9a-f]{40}$/i

/**
 * The one place this package knows a chain by name. It mirrors `contracts/deploy/profiles.ts`:
 * the target selects the row, and everything else (chain id, environment variable names, the
 * release manifest, the networks catalog) derives from it. A further chain is one more row here
 * plus its `deployments/<target>.json` and `config/networks.<target>.json`; no other indexer file
 * names a chain or a chain id.
 */
export const CHAIN_PROFILES = Object.freeze({
  local: Object.freeze({
    target: 'local',
    name: 'Local Anvil',
    chainId: 31337,
    public: false,
    rpcEnv: 'PONDER_RPC_URL_31337',
    wsEnv: 'PONDER_WS_URL_31337',
    startBlockEnv: 'PONDER_START_BLOCK',
    networksFile: 'config/networks.development.json',
  }),
  sepolia: Object.freeze({
    target: 'sepolia',
    name: 'Ethereum Sepolia',
    chainId: 11155111,
    public: true,
    rpcEnv: 'PONDER_RPC_URL_11155111',
    wsEnv: 'PONDER_WS_URL_11155111',
    startBlockEnv: 'PONDER_START_BLOCK_11155111',
    releaseManifestFile: 'deployments/sepolia.json',
    networksFile: 'config/networks.sepolia.json',
  }),
  mainnet: Object.freeze({
    target: 'mainnet',
    name: 'Ethereum Mainnet',
    chainId: 1,
    public: true,
    rpcEnv: 'PONDER_RPC_URL_1',
    wsEnv: 'PONDER_WS_URL_1',
    startBlockEnv: 'PONDER_START_BLOCK_1',
    releaseManifestFile: 'deployments/mainnet.json',
    networksFile: 'config/networks.mainnet.json',
  }),
})

export const DEPLOY_TARGETS = Object.freeze(Object.keys(CHAIN_PROFILES))

export function chainProfile(target) {
  if (typeof target !== 'string' || !Object.hasOwn(CHAIN_PROFILES, target)) {
    throw new Error(`DEPLOY_TARGET must be one of ${DEPLOY_TARGETS.join(', ')}`)
  }
  return CHAIN_PROFILES[target]
}

const nonzeroAddress = (value, label) => {
  if (
    typeof value !== 'string' ||
    !ADDRESS.test(value) ||
    /^0x0{40}$/i.test(value)
  ) {
    throw new Error(`${label} must be a nonzero address`)
  }
  return value
}

const manifestChainName = (manifest) =>
  typeof manifest?.chain === 'string' &&
  Object.hasOwn(CHAIN_PROFILES, manifest.chain)
    ? CHAIN_PROFILES[manifest.chain].name
    : 'Release'

export function manifestContractAddresses(manifest, chainName) {
  const label = chainName ?? manifestChainName(manifest)
  const addresses = Object.entries(manifest.contracts ?? {}).flatMap(
    ([name, record]) =>
      record?.address
        ? [nonzeroAddress(record.address, `${label} ${name}`)]
        : []
  )
  for (const instance of manifest.instances ?? []) {
    const contracts = instance.contracts ?? {}
    for (const key of [
      'merkleSnapshot',
      'easIndexerResolver',
      'merkleFundDistributor',
      'merkleGovModule',
      'anchorRegistry',
      'contributionResolver',
      'poolToken',
    ]) {
      if (contracts[key]) {
        addresses.push(
          nonzeroAddress(
            contracts[key],
            `${label} instance ${instance.instanceId ?? '<unknown>'} ${key}`
          )
        )
      }
    }
    if (contracts.safe?.proxy) {
      addresses.push(
        nonzeroAddress(
          contracts.safe.proxy,
          `${label} instance ${instance.instanceId ?? '<unknown>'} safe proxy`
        )
      )
    }
  }
  return addresses
}

/**
 * Read and validate the finalized release manifest for a public target. The manifest must bind
 * itself to the profile's chain (`chain` and `chainId` both), so a file copied between targets, or
 * a target pointed at the wrong file, fails before any RPC is contacted.
 */
export function loadFinalizedManifest(target, repoDir) {
  const profile = chainProfile(target)
  if (!profile.public) {
    throw new Error(`${profile.name} has no release manifest`)
  }
  const label = profile.name
  const file = path.join(repoDir, profile.releaseManifestFile)
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (
    manifest.version !== 1 ||
    manifest.status !== 'deployed' ||
    manifest.stage !== 'production' ||
    manifest.chain !== target ||
    manifest.chainId !== profile.chainId
  ) {
    throw new Error(
      `${profile.releaseManifestFile} must be a finalized production ${label} manifest ` +
        `(chain=${target}, chainId=${profile.chainId})`
    )
  }
  if (
    !Number.isSafeInteger(manifest.firstDeploymentBlock) ||
    manifest.firstDeploymentBlock < 0
  ) {
    throw new Error(
      `${label} manifest firstDeploymentBlock is missing or invalid`
    )
  }
  if (
    typeof manifest.deploymentCommit !== 'string' ||
    !COMMIT.test(manifest.deploymentCommit)
  ) {
    throw new Error(`${label} manifest deploymentCommit is missing or invalid`)
  }
  for (const [key, program] of [
    ['trustGraph', 'trust-graph'],
    ['weighted', 'trust-graph-weighted'],
    ['composition', 'trust-compose'],
    ['signer', 'signer-sync'],
    ['contributions', 'contributions'],
    ['hypercerts', 'hypercerts'],
    ['nostrWorkspace', 'nostr-workspace'],
  ]) {
    for (const [field, value] of [
      ['ELF digest', manifest.programs?.[key]?.elfSha256],
      ['vkey', manifest.programs?.[key]?.vkey],
    ]) {
      if (
        typeof value !== 'string' ||
        !BYTES32.test(value) ||
        /^0x0{64}$/i.test(value)
      ) {
        throw new Error(`${label} ${program} ${field} is missing or invalid`)
      }
    }
  }
  nonzeroAddress(manifest.external?.sp1Gateway, `${label} SP1 gateway`)
  for (const name of [
    'schemaRegistrar',
    'rootVerifier',
    'instanceRegistry',
    'trustgraphsFactory',
  ]) {
    const record = manifest.contracts?.[name]
    nonzeroAddress(record?.address, `${label} ${name}`)
    if (!Number.isSafeInteger(record?.block) || record.block < 0) {
      throw new Error(`${label} ${name} deployment block is missing or invalid`)
    }
  }
  for (const [family, names] of [
    [
      'weighted',
      [
        'weightedVerifier',
        'weightedTrustgraphsFactory',
        'governedWeightedTrustgraphsFactory',
      ],
    ],
    [
      'composition',
      [
        'compositionVerifier',
        'trustComposeFactory',
        'governedTrustComposeFactory',
      ],
    ],
    ['contributions', ['contributionsVerifier', 'contributionsFactory']],
    // The fast (EPOCH_FLOOR = 1) factory generations: optional per family, never half-recorded.
    ['fast', ['trustgraphsFactoryFast', 'governedTrustgraphsFactoryFast']],
    [
      'fastWeighted',
      [
        'weightedTrustgraphsFactoryFast',
        'governedWeightedTrustgraphsFactoryFast',
      ],
    ],
    [
      'fastComposition',
      ['trustComposeFactoryFast', 'governedTrustComposeFactoryFast'],
    ],
    ['fastContributions', ['contributionsFactoryFast']],
  ]) {
    const records = names.map((name) => manifest.contracts?.[name])
    const deployed = records.filter((record) => record?.address).length
    if (deployed !== 0 && deployed !== records.length) {
      throw new Error(`${label} ${family} deployment is incomplete`)
    }
    if (deployed === records.length) {
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index]
        const name = names[index]
        nonzeroAddress(record.address, `${label} ${name}`)
        if (!Number.isSafeInteger(record.block) || record.block < 0) {
          throw new Error(
            `${label} ${name} deployment block is missing or invalid`
          )
        }
      }
    }
  }
  return { file, manifest, profile }
}

/**
 * Resolve deployment strictness (stage) independently from chain identity (target), then attach
 * everything the launcher and `ponder.config.ts` need from the selected profile row. Stage decides
 * how strict validation is; target decides which chain. Naming neither is the local development
 * default; naming a public target without a stage implies production.
 */
export function resolveDeploymentProfile(environment, repoDir) {
  let stage = environment.DEPLOY_STAGE?.trim().toLowerCase()
  let target = environment.DEPLOY_TARGET?.trim().toLowerCase()

  if (!stage && target) {
    stage = chainProfile(target).public ? 'production' : 'development'
  }
  if (!stage) stage = 'development'
  if (!target) {
    if (stage === 'production') {
      throw new Error('Production indexer requires DEPLOY_TARGET')
    }
    target = 'local'
  }
  if (!['development', 'production'].includes(stage)) {
    throw new Error('DEPLOY_STAGE must be development or production')
  }
  const profile = chainProfile(target)
  if ((stage === 'development') === profile.public) {
    throw new Error(`Invalid deployment profile ${stage}/${target}`)
  }

  const shared = {
    stage,
    target,
    production: profile.public,
    chainId: profile.chainId,
    chainName: profile.name,
    rpcEnv: profile.rpcEnv,
    wsEnv: profile.wsEnv,
    startBlockEnv: profile.startBlockEnv,
    networksFile: path.join(repoDir, profile.networksFile),
  }

  if (profile.public) {
    const { file, manifest } = loadFinalizedManifest(target, repoDir)
    return {
      ...shared,
      defaultStartBlock: manifest.firstDeploymentBlock,
      deploymentFile: file,
      requiredCodeAddresses: manifestContractAddresses(manifest, profile.name),
    }
  }

  return {
    ...shared,
    defaultStartBlock: 1,
    deploymentFile: path.join(repoDir, '.docker', 'deployment_summary.json'),
  }
}
