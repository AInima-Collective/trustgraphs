/**
 * Script to generate config.ENV.json from the deployment summary.
 */

import * as fs from 'fs'
import * as path from 'path'

const env = process.env.NODE_ENV || 'development'
const configOutputFile = path.join(__dirname, `../config.${env}.json`)
const configOutput: any = {}

// Path to deployment summary and config files
const deploymentSummaryFile = path.join(
  __dirname,
  '../../.docker/deployment_summary.json'
)

// The permissionless instance factory (docs/build/create-a-network.md). It is deployed once per chain
// by its own step, so it lands in its own file rather than the deployment summary. Absent on chains
// where the factory has not been stood up yet — the create wizard hides itself in that case.
const factoryDeployFile = path.join(
  __dirname,
  '../../.docker/factory_deploy.json'
)
const factoryAddress = fs.existsSync(factoryDeployFile)
  ? (JSON.parse(fs.readFileSync(factoryDeployFile, 'utf8')).factory ?? '')
  : ''
const governedFactoryDeployFile = path.join(
  __dirname,
  '../../.docker/governed_factory_deploy.json'
)
const governedFactoryAddress = fs.existsSync(governedFactoryDeployFile)
  ? (JSON.parse(fs.readFileSync(governedFactoryDeployFile, 'utf8'))
      .governed_factory ?? '')
  : ''
const signerVerifierDeployFile = path.join(
  __dirname,
  '../../.docker/zk_verifier_signer_deploy.json'
)
const signerVerifierDeployment = fs.existsSync(signerVerifierDeployFile)
  ? JSON.parse(fs.readFileSync(signerVerifierDeployFile, 'utf8'))
  : {}

console.log('🔄 Updating config with latest deployment data...')

try {
  // Read configs
  const deployment = JSON.parse(fs.readFileSync(deploymentSummaryFile, 'utf8'))

  console.log('📋 Found deployment data')

  // Set chain based on environment
  configOutput.chain = env === 'development' ? 'local' : 'optimism'
  configOutput.apis = {
    ponder:
      env === 'development'
        ? 'http://127.0.0.1:65421'
        : // No production deployment exists today; set PONDER_URL when one does.
          process.env.PONDER_URL || 'https://ponder.example.com/ponder',
    ipfsGateway:
      env === 'development'
        ? 'http://127.0.0.1:8080/ipfs/'
        : 'https://gateway.pinata.cloud/ipfs/',
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
  // trust-compose is additive and may roll out after the existing factory/indexer. An absent
  // address keeps the workspace in explicit read-only preview mode.
  configOutput.trustCompose = {
    factory:
      deployment.trustComposeFactory?.trust_compose_factory ||
      process.env.TRUST_COMPOSE_FACTORY_ADDRESS ||
      '',
  }
  // The contributions round factory. Additive like trust-compose: an absent address keeps the
  // "start a contribution round" flow in explicit not-available mode.
  configOutput.contributionsFactory =
    deployment.contributionsFactory?.contributions_factory ||
    process.env.CONTRIBUTIONS_FACTORY_ADDRESS ||
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
        `../../out/${sourceFile}.sol/${name}.json`
      )
      const abiExists = fs.existsSync(abiPath)
      if (!abiExists) {
        throw new Error(
          `Could not find ABI for ${name} at ${abiPath}. Please ensure the contract name and file name match.`
        )
      }

      fs.copyFileSync(abiPath, path.join(__dirname, `../abis/${name}.json`))
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
