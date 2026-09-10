/**
 * Deploy contracts to the chain.
 *
 * Usage:
 * ```
 * pnpm deploy:contracts
 * ```
 */

import fs from 'fs'

import chalk from 'chalk'
import { Command } from 'commander'

import { DEPLOYMENT_SUMMARY_FILE } from './constants'
import { initProgram, SepoliaEnv } from './env'
import { assertReleaseCheckout } from '../../scripts/release-checkout.cjs'
import {
  assertGenerationComplete,
  beginGeneration,
  generationManifestPath,
} from './generation'
import {
  type ReleaseManifest,
  loadReleaseManifest,
  validateReleaseManifest,
} from './release-manifest'
import { execFull } from './utils'

const program = new Command('deploy-contracts')
  .description('Deploy contracts to the chain')
  .option(
    '--stage <stage>',
    'Deployment stage: development or production (default: $DEPLOY_STAGE)'
  )
  .option(
    '--chain <target>',
    'Chain target: local or sepolia (default: $DEPLOY_TARGET)'
  )
  .option(
    // Don't pass FUNDED_KEY as default here so it does not appear in the help
    // output. Instead it will be set via applyDefaultOptions().
    '-k, --funded-key <fundedKey>',
    'The funded private key for the deployer (default: $FUNDED_KEY from .env)'
  )
  .option(
    '-r, --rpc-url <rpcUrl>',
    'The RPC URL for the chain (default: $RPC_URL from .env)'
  )
  .option(
    '--dry-run',
    'Validate the selected profile and print the ordered plan without Forge or RPC calls'
  )
  .option(
    '--continue-existing',
    'Sepolia only: verify and preserve the five live contracts, then deploy only missing additive steps'
  )
  .option(
    '--new-generation <name>',
    'Sepolia only: deploy replacements into deployments/generations/<name>/sepolia.json; preserve the active deployment'
  )

const ANVIL_DEFAULT_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const requireFundedKey = (value: unknown, publicChain: boolean): string => {
  if (
    typeof value !== 'string' ||
    !/^0x[0-9a-f]{64}$/i.test(value) ||
    /^0x0{64}$/i.test(value)
  ) {
    throw new Error(
      'FUNDED_KEY must be an explicit nonzero 32-byte private key'
    )
  }
  if (publicChain && value.toLowerCase() === ANVIL_DEFAULT_KEY) {
    throw new Error('The known Anvil default key is forbidden on public chains')
  }
  return value
}

const SEPOLIA_CORE_CONTRACTS = [
  'schemaRegistrar',
  'rootVerifier',
  'instanceRegistry',
  'provingVault',
  'trustgraphsFactory',
] as const

const rpc = async (url: string, method: string, params: unknown[] = []) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok)
    throw new Error(`Sepolia RPC returned HTTP ${response.status}`)
  const body = (await response.json()) as {
    result?: string
    error?: { message?: string }
  }
  if (body.error) {
    throw new Error(
      `Sepolia RPC ${method} failed: ${body.error.message || 'unknown error'}`
    )
  }
  return body.result
}

const verifySepoliaContinuation = async (
  manifest: ReleaseManifest,
  rpcUrl: string
) => {
  if (manifest.status !== 'deployed') {
    throw new Error('--continue-existing requires a deployed Sepolia manifest')
  }
  const chainId = await rpc(rpcUrl, 'eth_chainId')
  if (chainId === undefined || Number(BigInt(chainId)) !== manifest.chainId) {
    throw new Error(
      `Continuation RPC is chain ${chainId ?? 'unknown'}, expected ${manifest.chainId}`
    )
  }
  for (const key of SEPOLIA_CORE_CONTRACTS) {
    const address = manifest.contracts[key].address
    if (!address) {
      throw new Error(`Sepolia manifest has no live ${key} address to preserve`)
    }
    const code = await rpc(rpcUrl, 'eth_getCode', [address, 'latest'])
    if (!code || code === '0x' || code === '0x0') {
      throw new Error(
        `Sepolia continuation refused: manifest ${key} has no code at ${address}`
      )
    }
  }
}

const assertCoreUnchanged = (
  before: ReleaseManifest,
  after: ReleaseManifest
) => {
  for (const key of SEPOLIA_CORE_CONTRACTS) {
    const previous = before.contracts[key].address?.toLowerCase()
    const next = after.contracts[key].address?.toLowerCase()
    if (previous !== next) {
      throw new Error(
        `Sepolia continuation changed ${key} from ${previous} to ${next}; refusing to overwrite the manifest`
      )
    }
  }
}

const main = async () => {
  const context = initProgram(program)
  const {
    env,
    options: { fundedKey, dryRun, continueExisting, newGeneration },
  } = context

  await env.validateDeployment?.()
  if (env.profile.public) assertReleaseCheckout(process.env.DEPLOYMENT_COMMIT)

  const sepoliaManifest =
    env.profile.target === 'sepolia'
      ? loadReleaseManifest('deployments/sepolia.json', {
          requireComplete: Boolean(continueExisting),
        })
      : undefined
  if (continueExisting && env.profile.target !== 'sepolia') {
    throw new Error('--continue-existing is only valid for Sepolia')
  }
  if (
    sepoliaManifest?.status === 'deployed' &&
    !continueExisting &&
    !newGeneration
  ) {
    throw new Error(
      'Sepolia already has a deployed manifest. Use --new-generation <name> for replacements or pnpm deploy:sepolia:continue for missing additive steps.'
    )
  }
  if (continueExisting && sepoliaManifest) {
    await verifySepoliaContinuation(sepoliaManifest, env.rpcUrl)
  }
  const activeBytes = newGeneration
    ? fs.readFileSync('deployments/sepolia.json', 'utf8')
    : undefined
  if (
    newGeneration &&
    fs.existsSync(
      generationManifestPath(newGeneration).replace(/\/sepolia\.json$/, '')
    )
  ) {
    throw new Error(
      'Generation directory already exists; preserve its receipts and reconcile the prior attempt before retrying'
    )
  }

  if (dryRun) {
    console.log(
      chalk.greenBright(
        `Dry run: ${env.stage}/${env.profile.target} (${env.profile.chainId})`
      )
    )
    for (const [index, contract] of env.deployContracts.entries()) {
      const skipped = await contract.skip?.(context)
      console.log(
        `${index + 1}. ${contract.name} — ${contract.script}${skipped ? ' [skipped by configuration]' : ''}`
      )
    }
    if (newGeneration)
      console.log(
        `Candidate output: ${env.profile.releaseManifestFile}; active deployments/sepolia.json is preserved.`
      )
    console.log(
      continueExisting
        ? 'The continuation made read-only RPC checks; no Forge scripts, files, or broadcasts were performed.'
        : 'No RPC calls, Forge scripts, files, or broadcasts were performed.'
    )
    return
  }

  const privateKey = requireFundedKey(fundedKey, env.profile.public)
  if (newGeneration && env instanceof SepoliaEnv) {
    const chain = await rpc(env.rpcUrl, 'eth_chainId')
    if (!chain || BigInt(chain) !== 11155111n)
      throw new Error('New generation RPC must be Sepolia (11155111)')
    beginGeneration(
      newGeneration,
      env.releaseBase,
      activeBytes!,
      fs.readFileSync(
        process.env.GUEST_MANIFEST || 'guest-manifest.json',
        'utf8'
      )
    )
  }

  for (const contract of env.deployContracts) {
    const skip = await contract.skip?.(context)
    if (skip) {
      console.log(chalk.yellowBright(`🚫 ${contract.name} skipped`))
      continue
    }

    console.log(chalk.blueBright(`🚀 Deploying ${contract.name}...`))

    // Recheck after asynchronous RPC/continuation work, immediately before compiling/broadcasting.
    if (env.profile.public) assertReleaseCheckout(process.env.DEPLOYMENT_COMMIT)
    await execFull({
      cmd: [
        'forge',
        'script',
        contract.script,
        '--sig',
        `"${contract.sig}"`,
        ...contract.args(context).map((arg) => `"${arg}"`),
        '--rpc-url',
        `"${env.rpcUrl}"`,
        '--private-key',
        '"$FUNDED_KEY"',
        '--broadcast',
        // Send one tx at a time, waiting for each receipt before the next. Without this, forge
        // signs a whole script's batch with sequential nonces and fires them at once; if the RPC
        // drops the first send (e.g. under load from a concurrently-running indexer), every later
        // nonce lands in anvil's "queued" set behind the gap and forge polls their receipts
        // forever (observed hanging DeployTimelocks: txpool pending 0 / queued 16).
        '--slow',
      ],
      log: 'cmd',
      env: {
        FUNDED_KEY: privateKey,
        EXPECTED_CHAIN_ID: String(env.profile.chainId),
        ...contract.env?.(context),
      },
      shell: true,
    })

    await contract.postRun?.(context)

    console.log(chalk.yellowBright(`✅ ${contract.name} deployed`))
  }

  await env.postDeployContracts?.()

  const releaseManifestFile = env.profile.releaseManifestFile
  if (releaseManifestFile && env.generateReleaseManifest) {
    const generatedManifest = validateReleaseManifest(
      env.generateReleaseManifest(context),
      { requireComplete: true }
    )
    if (continueExisting && sepoliaManifest) {
      assertCoreUnchanged(sepoliaManifest, generatedManifest)
    }
    if (newGeneration && env instanceof SepoliaEnv) {
      assertGenerationComplete(env.releaseBase, generatedManifest)
      if (fs.readFileSync('deployments/sepolia.json', 'utf8') !== activeBytes) {
        throw new Error(
          'Active Sepolia manifest changed during deployment; preserve receipts and reconcile before finalizing'
        )
      }
    }
    fs.writeFileSync(
      releaseManifestFile,
      `${JSON.stringify(generatedManifest, null, 2)}\n`
    )
  } else {
    fs.writeFileSync(
      DEPLOYMENT_SUMMARY_FILE,
      JSON.stringify(env.generateDeploymentSummary(), null, 2)
    )
  }

  console.log(
    chalk.greenBright(
      `🎉 All contracts deployed successfully! Deployment record saved to ${releaseManifestFile || DEPLOYMENT_SUMMARY_FILE}`
    )
  )
}

main().catch((err) => {
  console.error(chalk.redBright(err.message))
  process.exit(1)
})

process.on('SIGINT', () => {
  console.error(chalk.redBright('SIGINT received. Shutting down...'))
  process.exit(1)
})

process.on('SIGTERM', () => {
  console.error(chalk.redBright('SIGTERM received. Shutting down...'))
  process.exit(1)
})
