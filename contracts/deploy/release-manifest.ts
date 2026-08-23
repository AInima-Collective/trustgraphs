import fs from 'fs'
import path from 'path'

import type { Hex } from 'viem'

import { ChainTarget, DeploymentStage } from './types'

export type DeploymentRecord = {
  address: Hex | null
  block: number | null
  txHash: Hex | null
}

export type ReleaseManifest = {
  $schema: string
  version: 1
  status: 'planned' | 'deployed'
  stage: DeploymentStage
  chain: ChainTarget
  chainId: number
  deploymentCommit: string | null
  firstDeploymentBlock: number | null
  external: {
    eas: Hex
    schemaRegistry: Hex
    sp1Gateway: Hex | null
    ethUsdFeed: Hex | null
    usdc: Hex | null
  }
  contracts: {
    schemaRegistrar: DeploymentRecord
    rootVerifier: DeploymentRecord
    instanceRegistry: DeploymentRecord
    provingVault: DeploymentRecord
    trustgraphsFactory: DeploymentRecord
  }
  programs: {
    trustGraph: {
      sp1Version: string
      elfSha256: Hex | null
      vkey: Hex | null
    }
  }
  instances: Array<{
    instanceId: Hex
    name: string
    contracts: {
      merkleSnapshot: Hex
      easIndexerResolver: Hex
      merkleFundDistributor?: Hex
      paramsController?: Hex
    }
    schemaUid: Hex
  }>
}

const ADDRESS = /^0x[0-9a-f]{40}$/i
const BYTES32 = /^0x[0-9a-f]{64}$/i
const COMMIT = /^[0-9a-f]{40}$/i
const FORBIDDEN_KEYS = new Set([
  'rpc_url',
  'rpcUrl',
  'privateKey',
  'fundedKey',
  'apiKey',
  'databaseUrl',
  'alertWebhook',
  'secret',
])

const assertObject: (
  value: unknown,
  label: string
) => asserts value is Record<string, unknown> = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

const assertAddress = (value: unknown, label: string, nullable = false) => {
  if (nullable && value === null) return
  if (
    typeof value !== 'string' ||
    !ADDRESS.test(value) ||
    /^0x0{40}$/i.test(value)
  ) {
    throw new Error(
      `${label} must be a 20-byte address${nullable ? ' or null' : ''}`
    )
  }
}

const assertKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
) => {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key))
  if (extras.length > 0) {
    throw new Error(`${label} contains unknown key ${extras[0]}`)
  }
}

const assertNoSecrets = (value: unknown, label = 'manifest') => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${label}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`${label} contains forbidden release-manifest key ${key}`)
    }
    assertNoSecrets(nested, `${label}.${key}`)
  }
}

const validateRecord = (
  value: unknown,
  label: string,
  requireComplete: boolean
) => {
  assertObject(value, label)
  assertKeys(value, ['address', 'block', 'txHash'], label)
  assertAddress(value.address, `${label}.address`, !requireComplete)
  if (
    value.block !== null &&
    (!Number.isSafeInteger(value.block) || Number(value.block) < 0)
  ) {
    throw new Error(
      `${label}.block must be a non-negative safe integer or null`
    )
  }
  if (requireComplete && value.block === null) {
    throw new Error(`${label}.block is required for a deployed manifest`)
  }
  if (
    value.txHash !== null &&
    (typeof value.txHash !== 'string' || !BYTES32.test(value.txHash))
  ) {
    throw new Error(`${label}.txHash must be bytes32 or null`)
  }
  if (requireComplete && value.txHash === null) {
    throw new Error(`${label}.txHash is required for a deployed manifest`)
  }
}

export const validateReleaseManifest = (
  value: unknown,
  { requireComplete = false }: { requireComplete?: boolean } = {}
): ReleaseManifest => {
  assertObject(value, 'manifest')
  assertNoSecrets(value)
  assertKeys(
    value,
    [
      '$schema',
      'version',
      'status',
      'stage',
      'chain',
      'chainId',
      'deploymentCommit',
      'firstDeploymentBlock',
      'external',
      'contracts',
      'programs',
      'instances',
    ],
    'manifest'
  )
  if (typeof value.$schema !== 'string' || value.$schema.length === 0) {
    throw new Error('manifest.$schema is required')
  }
  if (value.version !== 1) throw new Error('manifest.version must be 1')
  if (value.stage !== 'production') {
    throw new Error('public release manifest stage must be production')
  }
  if (value.chain !== 'sepolia' || value.chainId !== 11155111) {
    throw new Error(
      'Sepolia manifest must bind chain=sepolia and chainId=11155111'
    )
  }
  if (value.status !== 'planned' && value.status !== 'deployed') {
    throw new Error('manifest.status must be planned or deployed')
  }
  if (requireComplete && value.status !== 'deployed') {
    throw new Error('complete release manifest must have status=deployed')
  }
  if (
    value.deploymentCommit !== null &&
    (typeof value.deploymentCommit !== 'string' ||
      !COMMIT.test(value.deploymentCommit))
  ) {
    throw new Error(
      'manifest.deploymentCommit must be a full git commit or null'
    )
  }
  if (requireComplete && value.deploymentCommit === null) {
    throw new Error('manifest.deploymentCommit is required after deployment')
  }
  if (
    value.firstDeploymentBlock !== null &&
    (!Number.isSafeInteger(value.firstDeploymentBlock) ||
      Number(value.firstDeploymentBlock) < 0)
  ) {
    throw new Error(
      'manifest.firstDeploymentBlock must be a non-negative safe integer or null'
    )
  }
  if (requireComplete && value.firstDeploymentBlock === null) {
    throw new Error(
      'manifest.firstDeploymentBlock is required after deployment'
    )
  }
  assertObject(value.external, 'manifest.external')
  assertKeys(
    value.external,
    ['eas', 'schemaRegistry', 'sp1Gateway', 'ethUsdFeed', 'usdc'],
    'manifest.external'
  )
  assertAddress(value.external.eas, 'manifest.external.eas')
  assertAddress(
    value.external.schemaRegistry,
    'manifest.external.schemaRegistry'
  )
  assertAddress(
    value.external.sp1Gateway,
    'manifest.external.sp1Gateway',
    !requireComplete
  )
  assertAddress(value.external.ethUsdFeed, 'manifest.external.ethUsdFeed', true)
  assertAddress(value.external.usdc, 'manifest.external.usdc', true)

  assertObject(value.contracts, 'manifest.contracts')
  assertKeys(
    value.contracts,
    [
      'schemaRegistrar',
      'rootVerifier',
      'instanceRegistry',
      'provingVault',
      'trustgraphsFactory',
    ],
    'manifest.contracts'
  )
  for (const key of [
    'schemaRegistrar',
    'rootVerifier',
    'instanceRegistry',
    'trustgraphsFactory',
  ]) {
    validateRecord(
      value.contracts[key],
      `manifest.contracts.${key}`,
      requireComplete
    )
  }
  assertObject(value.contracts.provingVault, 'manifest.contracts.provingVault')
  validateRecord(
    value.contracts.provingVault,
    'manifest.contracts.provingVault',
    value.contracts.provingVault.address !== null
  )
  if (
    value.contracts.provingVault.address !== null &&
    (value.external.ethUsdFeed === null || value.external.usdc === null)
  ) {
    throw new Error(
      'manifest external feed and USDC are required when ProvingVault is deployed'
    )
  }

  assertObject(value.programs, 'manifest.programs')
  assertKeys(value.programs, ['trustGraph'], 'manifest.programs')
  assertObject(value.programs.trustGraph, 'manifest.programs.trustGraph')
  assertKeys(
    value.programs.trustGraph,
    ['sp1Version', 'elfSha256', 'vkey'],
    'manifest.programs.trustGraph'
  )
  if (value.programs.trustGraph.sp1Version !== '6.3.1') {
    throw new Error(
      'manifest trust-graph SP1 version must match the pinned 6.3.1 toolchain'
    )
  }
  if (
    value.programs.trustGraph.elfSha256 !== null &&
    (typeof value.programs.trustGraph.elfSha256 !== 'string' ||
      !BYTES32.test(value.programs.trustGraph.elfSha256))
  ) {
    throw new Error('manifest trust-graph ELF digest must be bytes32 or null')
  }
  if (
    value.programs.trustGraph.vkey !== null &&
    (typeof value.programs.trustGraph.vkey !== 'string' ||
      !BYTES32.test(value.programs.trustGraph.vkey))
  ) {
    throw new Error('manifest trust-graph vkey must be bytes32 or null')
  }
  if (requireComplete && value.programs.trustGraph.vkey === null) {
    throw new Error('manifest trust-graph vkey is required after deployment')
  }
  if (requireComplete && value.programs.trustGraph.elfSha256 === null) {
    throw new Error(
      'manifest trust-graph ELF digest is required after deployment'
    )
  }
  if (!Array.isArray(value.instances)) {
    throw new Error('manifest.instances must be an array')
  }
  value.instances.forEach((instance, index) => {
    const label = `manifest.instances[${index}]`
    assertObject(instance, label)
    assertKeys(
      instance,
      ['instanceId', 'name', 'contracts', 'schemaUid'],
      label
    )
    if (
      typeof instance.instanceId !== 'string' ||
      !BYTES32.test(instance.instanceId)
    ) {
      throw new Error(`${label}.instanceId must be bytes32`)
    }
    if (typeof instance.name !== 'string' || instance.name.length === 0) {
      throw new Error(`${label}.name must be nonempty`)
    }
    if (
      typeof instance.schemaUid !== 'string' ||
      !BYTES32.test(instance.schemaUid)
    ) {
      throw new Error(`${label}.schemaUid must be bytes32`)
    }
    assertObject(instance.contracts, `${label}.contracts`)
    assertKeys(
      instance.contracts,
      [
        'merkleSnapshot',
        'easIndexerResolver',
        'merkleFundDistributor',
        'paramsController',
      ],
      `${label}.contracts`
    )
    assertAddress(
      instance.contracts.merkleSnapshot,
      `${label}.contracts.merkleSnapshot`
    )
    assertAddress(
      instance.contracts.easIndexerResolver,
      `${label}.contracts.easIndexerResolver`
    )
    for (const optional of [
      'merkleFundDistributor',
      'paramsController',
    ] as const) {
      if (instance.contracts[optional] !== undefined) {
        assertAddress(
          instance.contracts[optional],
          `${label}.contracts.${optional}`
        )
      }
    }
  })

  return value as ReleaseManifest
}

export const loadReleaseManifest = (
  file: string,
  options: { requireComplete?: boolean } = {}
): ReleaseManifest =>
  validateReleaseManifest(JSON.parse(fs.readFileSync(file, 'utf8')), options)

type BroadcastDeployment = { block: number; txHash: Hex }

export const readBroadcastDeployments = (
  repositoryRoot: string,
  chainId: number
): Map<string, BroadcastDeployment> => {
  const root = path.join(repositoryRoot, 'broadcast')
  const result = new Map<string, BroadcastDeployment>()
  if (!fs.existsSync(root)) return result

  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(file)
        continue
      }
      if (
        entry.name !== 'run-latest.json' ||
        !file.includes(`${path.sep}${chainId}${path.sep}`)
      ) {
        continue
      }
      const run = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        transactions?: Array<{
          hash?: Hex
          contractAddress?: Hex
        }>
        receipts?: Array<{
          transactionHash?: Hex
          blockNumber?: string | number
          contractAddress?: Hex
        }>
      }
      const receiptByHash = new Map(
        (run.receipts ?? []).flatMap((receipt) => {
          if (!receipt.transactionHash || receipt.blockNumber === undefined)
            return []
          const block =
            typeof receipt.blockNumber === 'string'
              ? Number(BigInt(receipt.blockNumber))
              : receipt.blockNumber
          return [[receipt.transactionHash.toLowerCase(), block] as const]
        })
      )
      for (const transaction of run.transactions ?? []) {
        if (!transaction.contractAddress || !transaction.hash) continue
        const block = receiptByHash.get(transaction.hash.toLowerCase())
        if (block === undefined) continue
        result.set(transaction.contractAddress.toLowerCase(), {
          block,
          txHash: transaction.hash,
        })
      }
    }
  }
  visit(root)
  return result
}

export const deploymentRecord = (
  address: string | undefined,
  broadcasts: Map<string, BroadcastDeployment>
): DeploymentRecord => {
  if (!address) return { address: null, block: null, txHash: null }
  assertAddress(address, 'deployment address')
  const broadcast = broadcasts.get(address.toLowerCase())
  return {
    address: address as Hex,
    block: broadcast?.block ?? null,
    txHash: broadcast?.txHash ?? null,
  }
}

/** Convert the public release interface into the legacy consumer shape during migration. */
export const releaseManifestToDeploymentSummary = (
  manifest: ReleaseManifest
) => ({
  eas: {
    eas: manifest.external.eas,
    schema_registry: manifest.external.schemaRegistry,
    schema_registrar: manifest.contracts.schemaRegistrar.address,
  },
  factory: {
    factory: manifest.contracts.trustgraphsFactory.address,
    instance_registry: manifest.contracts.instanceRegistry.address,
  },
  provingVault: manifest.contracts.provingVault.address,
  networks: manifest.instances.map((instance) => ({
    id: instance.instanceId,
    name: instance.name,
    contracts: instance.contracts,
    schemas: [{ uid: instance.schemaUid }],
  })),
})
