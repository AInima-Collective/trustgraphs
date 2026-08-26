/**
 * Script to generate config.ENV.json from the deployment summary.
 */

import * as fs from 'fs'
import * as path from 'path'

import {
  loadReleaseManifest,
  releaseManifestToDeploymentSummary,
} from '../../../contracts/deploy/release-manifest'
import { loadTargetEnvironment } from '../../../scripts/load-env.cjs'

const repositoryRoot = path.join(__dirname, '../../..')
const env = process.env.NODE_ENV || 'development'
const { target } = loadTargetEnvironment({
  repositoryRoot,
  target: process.env.DEPLOY_TARGET,
  higherPriorityFiles: [path.join(__dirname, '../.env.local')],
  createBaseFrom: '.env.example',
  // A frontend-only .env.local is enough to run against a public deployment;
  // it should not require the deployer's secret-bearing repository overlay.
  requireTargetOverlay: false,
  // Vercel injects the build environment directly and has no ignored target overlay.
  fromProcess: process.env.VERCEL === '1',
})
const stage =
  process.env.DEPLOY_STAGE ||
  (env === 'development' ? 'development' : 'production')
if (!['development', 'production'].includes(stage)) {
  throw new Error('DEPLOY_STAGE must be development or production')
}
if (!['local', 'sepolia'].includes(target)) {
  throw new Error('DEPLOY_TARGET must be local or sepolia for the frontend')
}
if ((stage === 'development') !== (target === 'local')) {
  throw new Error(`Invalid deployment profile ${stage}/${target}`)
}
const isSepolia = target === 'sepolia'
const isPublic = stage === 'production'
const configName = isSepolia ? 'sepolia' : env
const configOutputFile = path.join(__dirname, `../config.${configName}.json`)
const configOutput: any = {}

const requiredPublicUrl = (
  name: string,
  options: { requiredSuffix?: string } = {}
): string => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for a public frontend build`)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${name} must be an absolute http(s) URL`)
  }
  if (
    parsed.hostname === 'example.com' ||
    parsed.hostname.endsWith('.example.com')
  ) {
    throw new Error(`${name} must not use an example.com placeholder`)
  }
  if (
    options.requiredSuffix &&
    !parsed.pathname.endsWith(options.requiredSuffix)
  ) {
    throw new Error(`${name} must end with ${options.requiredSuffix}`)
  }
  if (options.requiredSuffix && (parsed.search || parsed.hash)) {
    throw new Error(`${name} must not include a query string or fragment`)
  }
  return value
}

if (isPublic) {
  const primaryRpc = requiredPublicUrl('RPC_URL_11155111_0')
  const fallbackRpc = requiredPublicUrl('RPC_URL_11155111_1')
  requiredPublicUrl('RPC_URL_1')
  if (primaryRpc === fallbackRpc) {
    throw new Error(
      'RPC_URL_11155111_0 and RPC_URL_11155111_1 must use independent endpoints'
    )
  }
}

// Path to deployment summary and config files
const deploymentSummaryFile = path.join(
  __dirname,
  '../../../.docker/deployment_summary.json'
)
const releaseManifestFile = path.join(
  __dirname,
  '../../../deployments/sepolia.json'
)

// The permissionless instance factory (docs/build/create-a-network.md). It is deployed once per chain
// by its own step, so it lands in its own file rather than the deployment summary. Absent on chains
// where the factory has not been stood up yet — the create wizard hides itself in that case.
const factoryDeployFile = path.join(
  __dirname,
  '../../../.docker/factory_deploy.json'
)
const localFactoryAddress = fs.existsSync(factoryDeployFile)
  ? (JSON.parse(fs.readFileSync(factoryDeployFile, 'utf8')).factory ?? '')
  : ''
const governedFactoryDeployFile = path.join(
  __dirname,
  '../../../.docker/governed_factory_deploy.json'
)
const localGovernedFactoryAddress = fs.existsSync(governedFactoryDeployFile)
  ? (JSON.parse(fs.readFileSync(governedFactoryDeployFile, 'utf8'))
      .governed_factory ?? '')
  : ''
const signerVerifierDeployFile = path.join(
  __dirname,
  '../../../.docker/zk_verifier_signer_deploy.json'
)
const localSignerVerifierDeployment = fs.existsSync(signerVerifierDeployFile)
  ? JSON.parse(fs.readFileSync(signerVerifierDeployFile, 'utf8'))
  : {}

console.log('🔄 Updating config with latest deployment data...')

try {
  // Read configs
  const deployment: any = isSepolia
    ? releaseManifestToDeploymentSummary(
        loadReleaseManifest(releaseManifestFile, { requireComplete: true })
      )
    : JSON.parse(fs.readFileSync(deploymentSummaryFile, 'utf8'))
  const factoryAddress = isSepolia
    ? deployment.factory?.factory || ''
    : localFactoryAddress
  const signerVerifierDeployment: any = isSepolia
    ? deployment.signerVerifier || {}
    : localSignerVerifierDeployment
  const governedFactoryAddress = isSepolia
    ? deployment.governedFactory?.governed_factory || ''
    : localGovernedFactoryAddress

  console.log('📋 Found deployment data')

  // Set chain based on environment
  configOutput.chain = isSepolia ? 'sepolia' : 'local'
  configOutput.apis = {
    ponder: !isPublic
      ? 'http://127.0.0.1:65421'
      : requiredPublicUrl('PONDER_URL'),
    ipfsGateway: !isPublic
      ? 'http://127.0.0.1:8080/ipfs/'
      : requiredPublicUrl('IPFS_GATEWAY_PUBLIC', {
          requiredSuffix: '/ipfs/',
        }),
  }
  configOutput.signerSync = {
    verifier: signerVerifierDeployment.zk_verifier ?? '',
    programVKey: signerVerifierDeployment.program_vkey ?? '',
  }
  // The weighted lane uses an isolated hand-audited ABI in its workspace. Keeping this address
  // outside the generated binary contract map also lets older deployments offer import/export
  // without pretending that weighted signing is available.
  configOutput.weightedFactory =
    deployment.weightedFactory?.weighted_factory ||
    process.env.WEIGHTED_FACTORY_ADDRESS ||
    ''
  // The governed wrapper for the weighted factory. Absent means this deployment cannot offer
  // "create with governance" on the weighted workspace; the ungoverned path keeps working.
  configOutput.governedWeightedFactory =
    deployment.governedWeightedFactory?.governed_weighted_factory ||
    process.env.GOVERNED_WEIGHTED_FACTORY_ADDRESS ||
    ''
  // The fast (EPOCH_FLOOR = 1) trust-graph factory generation. Additive like the weighted lane:
  // absent addresses leave the create wizard on the original generation. Kept outside
  // `configOutput.contracts` because that map drives ABI/wagmi generation and this pair reuses
  // the TrustgraphsFactory / GovernedTrustgraphsFactory ABIs verbatim.
  configOutput.fastFactory = {
    factory:
      deployment.factoryFast?.factory ||
      process.env.TRUSTGRAPHS_FACTORY_FAST_ADDRESS ||
      '',
    governedFactory:
      deployment.governedFactoryFast?.governed_factory ||
      process.env.GOVERNED_TRUSTGRAPHS_FACTORY_FAST_ADDRESS ||
      '',
  }
  // The fast (EPOCH_FLOOR = 1) weighted factory generation, `fastFactory`'s pattern applied to
  // the weighted lane: when both addresses are present the weighted workspace creates through
  // this pair; absent or empty keeps it on the original generation.
  configOutput.fastWeightedFactory = {
    factory:
      deployment.weightedFactoryFast?.weighted_factory ||
      process.env.WEIGHTED_FACTORY_FAST_ADDRESS ||
      '',
    governedFactory:
      deployment.governedWeightedFactoryFast?.governed_weighted_factory ||
      process.env.GOVERNED_WEIGHTED_FACTORY_FAST_ADDRESS ||
      '',
  }
  // trust-compose is additive and may roll out after the existing factory/indexer. An absent
  // address keeps the workspace in explicit read-only preview mode. The governed wrapper follows
  // the same rule for the composition workspace's "create with governance" choice.
  configOutput.trustCompose = {
    factory:
      deployment.trustComposeFactory?.trust_compose_factory ||
      process.env.TRUST_COMPOSE_FACTORY_ADDRESS ||
      '',
    governedFactory:
      deployment.governedComposeFactory?.governed_compose_factory ||
      process.env.GOVERNED_COMPOSE_FACTORY_ADDRESS ||
      '',
  }
  // The fast trust-compose generation, same rules as `fastWeightedFactory`.
  configOutput.fastTrustCompose = {
    factory:
      deployment.trustComposeFactoryFast?.trust_compose_factory ||
      process.env.TRUST_COMPOSE_FACTORY_FAST_ADDRESS ||
      '',
    governedFactory:
      deployment.governedComposeFactoryFast?.governed_compose_factory ||
      process.env.GOVERNED_COMPOSE_FACTORY_FAST_ADDRESS ||
      '',
  }
  // The contributions round factory. Additive like trust-compose: an absent address keeps the
  // "start a contribution round" flow in explicit not-available mode.
  configOutput.contributionsFactory =
    deployment.contributionsFactory?.contributions_factory ||
    process.env.CONTRIBUTIONS_FACTORY_ADDRESS ||
    ''
  // The fast contributions generation (no governed wrapper exists for contributions rounds).
  configOutput.fastContributionsFactory =
    deployment.contributionsFactoryFast?.contributions_factory ||
    process.env.CONTRIBUTIONS_FACTORY_FAST_ADDRESS ||
    ''
  // The graph-of-graphs registry is a separate advisory plane. Rolling deployments may omit it;
  // the provenance route then reports the feature as unavailable without affecting score pages.
  configOutput.graphLineage = {
    registry:
      deployment.graphLineage?.registry ||
      process.env.GRAPH_LINEAGE_REGISTRY_ADDRESS ||
      '',
  }

  // Contract name mappings to contract addresses
  configOutput.contracts = {
    // EAS
    EAS: deployment.eas.eas,
    SchemaRegistrar: deployment.eas.schema_registrar,
    SchemaRegistry: deployment.eas.schema_registry,

    // Generate ABIs but set no address since each network has its own.
    GnosisSafe: '',
    EASIndexerResolver: '',
    MerkleSnapshot: '',
    MerkleGovModule: '',
    SignerSyncZkModule: '',
    SignerSyncModuleDeployer: '',
    MerkleFundDistributor: '',
    // Lane-2 (envelope-0) anchor accumulator; exposes anchorAcc()/anchorCount()
    // views + AnchorsCheckpointed/HeadAnchored events for journal-v2 verification.
    AnchorRegistry: '',
    // Contributions program (per-instance addresses live in networks.json): the three-schema
    // resolver + accumulator, the trust-accumulator mirror, and the local pool token (6dp).
    ContributionResolver: '',
    TrustAccumulatorMirror: '',
    TestUSDC: '',

    // One per chain: communities fund this tank to pay whoever proves their next root. The
    // deployment summary carries it as a bare address rather than under `networks` because every
    // factory instance shares the same vault.
    ProvingVault: deployment.provingVault || '',

    // One per chain: the base factory is the catalog source; the wizard writes through the
    // governed wrapper so the resulting instance is Safe-owned from creation.
    TrustgraphsFactory: factoryAddress,
    GovernedTrustgraphsFactory: governedFactoryAddress,
  }

  // Make sure ABIs exist for all contracts, and copy them to the frontend.
  Object.keys(configOutput.contracts)
    .sort()
    .forEach((name) => {
      const sourceFile =
        name === 'SignerSyncModuleDeployer' ? 'InstanceDeployers' : name
      const abiPath = path.join(
        __dirname,
        `../../../out/${sourceFile}.sol/${name}.json`
      )
      const frontendAbiPath = path.join(__dirname, `../abis/${name}.json`)

      // Foundry's out/ directory is intentionally gitignored and is not present in a
      // Vercel checkout. Refresh the committed frontend ABI when a local artifact is
      // available; otherwise use the committed copy that ships with the frontend.
      if (fs.existsSync(abiPath)) {
        fs.copyFileSync(abiPath, frontendAbiPath)
      } else if (!fs.existsSync(frontendAbiPath)) {
        throw new Error(
          `Could not find ABI for ${name}. Looked for a Foundry artifact at ${abiPath} and a committed frontend ABI at ${frontendAbiPath}.`
        )
      }
    })

  fs.writeFileSync(configOutputFile, JSON.stringify(configOutput, null, 2))

  console.log(`🚀 ${configOutputFile} updated!`)
} catch (error: any) {
  console.error(`❌ Error updating ${configOutputFile}:`, error.message)
  if (error.code === 'ENOENT') {
    console.error(
      '💡 Make sure the deployment summary file exists at:',
      deploymentSummaryFile
    )
  }
  process.exit(1)
}
