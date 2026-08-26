import fs from 'node:fs'
import path from 'node:path'

const ADDRESS = /^0x[0-9a-f]{40}$/i
const BYTES32 = /^0x[0-9a-f]{64}$/i
const COMMIT = /^[0-9a-f]{40}$/i

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

export function manifestContractAddresses(manifest) {
  const addresses = Object.entries(manifest.contracts ?? {}).flatMap(
    ([name, record]) =>
      record?.address ? [nonzeroAddress(record.address, `Sepolia ${name}`)] : []
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
            `Sepolia instance ${instance.instanceId ?? '<unknown>'} ${key}`
          )
        )
      }
    }
    if (contracts.safe?.proxy) {
      addresses.push(
        nonzeroAddress(
          contracts.safe.proxy,
          `Sepolia instance ${instance.instanceId ?? '<unknown>'} safe proxy`
        )
      )
    }
  }
  return addresses
}

export function loadFinalizedSepoliaManifest(repoDir) {
  const file = path.join(repoDir, 'deployments', 'sepolia.json')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (
    manifest.version !== 1 ||
    manifest.status !== 'deployed' ||
    manifest.stage !== 'production' ||
    manifest.chain !== 'sepolia' ||
    manifest.chainId !== 11155111
  ) {
    throw new Error(
      'deployments/sepolia.json must be a finalized production Sepolia manifest'
    )
  }
  if (
    !Number.isSafeInteger(manifest.firstDeploymentBlock) ||
    manifest.firstDeploymentBlock < 0
  ) {
    throw new Error(
      'Sepolia manifest firstDeploymentBlock is missing or invalid'
    )
  }
  if (
    typeof manifest.deploymentCommit !== 'string' ||
    !COMMIT.test(manifest.deploymentCommit)
  ) {
    throw new Error('Sepolia manifest deploymentCommit is missing or invalid')
  }
  for (const [key, label] of [
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
        throw new Error(`Sepolia ${label} ${field} is missing or invalid`)
      }
    }
  }
  nonzeroAddress(manifest.external?.sp1Gateway, 'Sepolia SP1 gateway')
  for (const name of [
    'schemaRegistrar',
    'rootVerifier',
    'instanceRegistry',
    'trustgraphsFactory',
  ]) {
    const record = manifest.contracts?.[name]
    nonzeroAddress(record?.address, `Sepolia ${name}`)
    if (!Number.isSafeInteger(record?.block) || record.block < 0) {
      throw new Error(`Sepolia ${name} deployment block is missing or invalid`)
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
    // The fast (EPOCH_FLOOR = 1) factory generation: optional as a pair, never half-recorded.
    ['fast', ['trustgraphsFactoryFast', 'governedTrustgraphsFactoryFast']],
  ]) {
    const records = names.map((name) => manifest.contracts?.[name])
    const deployed = records.filter((record) => record?.address).length
    if (deployed !== 0 && deployed !== records.length) {
      throw new Error(`Sepolia ${family} deployment is incomplete`)
    }
    if (deployed === records.length) {
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index]
        const name = names[index]
        nonzeroAddress(record.address, `Sepolia ${name}`)
        if (!Number.isSafeInteger(record.block) || record.block < 0) {
          throw new Error(
            `Sepolia ${name} deployment block is missing or invalid`
          )
        }
      }
    }
  }
  return { file, manifest }
}

export function resolveDeploymentProfile(environment, repoDir) {
  let stage = environment.DEPLOY_STAGE?.trim().toLowerCase()
  let target = environment.DEPLOY_TARGET?.trim().toLowerCase()

  if (!stage && target)
    stage = target === 'local' ? 'development' : 'production'
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
  if (!['local', 'sepolia'].includes(target)) {
    throw new Error('DEPLOY_TARGET must be local or sepolia')
  }
  if ((stage === 'development') !== (target === 'local')) {
    throw new Error(`Invalid deployment profile ${stage}/${target}`)
  }

  if (target === 'sepolia') {
    const { file, manifest } = loadFinalizedSepoliaManifest(repoDir)
    return {
      stage,
      target,
      production: true,
      chainId: 11155111,
      rpcEnv: 'PONDER_RPC_URL_11155111',
      startBlockEnv: 'PONDER_START_BLOCK_11155111',
      defaultStartBlock: manifest.firstDeploymentBlock,
      deploymentFile: file,
      requiredCodeAddresses: manifestContractAddresses(manifest),
    }
  }

  return {
    stage,
    target,
    production: false,
    chainId: 31337,
    rpcEnv: 'PONDER_RPC_URL_31337',
    startBlockEnv: 'PONDER_START_BLOCK',
    defaultStartBlock: 1,
    deploymentFile: path.join(repoDir, '.docker', 'deployment_summary.json'),
  }
}
