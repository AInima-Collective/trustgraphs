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
import { initProgram } from './env'
import { execFull } from './utils'

const program = new Command('deploy-contracts')
  .description('Deploy contracts to the chain')
  .option(
    '--stage <stage>',
    'Deployment stage: development or production (default: $DEPLOY_STAGE)'
  )
  .option(
    '--chain <target>',
    'Chain target: local, optimism, or sepolia (default: $DEPLOY_TARGET)'
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

const main = async () => {
  const context = initProgram(program)
  const {
    env,
    options: { fundedKey, dryRun },
  } = context

  await env.validateDeployment?.()

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
    console.log(
      'No RPC calls, Forge scripts, files, or broadcasts were performed.'
    )
    return
  }

  const privateKey = requireFundedKey(fundedKey, env.profile.public)

  for (const contract of env.deployContracts) {
    const skip = await contract.skip?.(context)
    if (skip) {
      console.log(chalk.yellowBright(`🚫 ${contract.name} skipped`))
      continue
    }

    console.log(chalk.blueBright(`🚀 Deploying ${contract.name}...`))

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
    fs.writeFileSync(
      releaseManifestFile,
      `${JSON.stringify(env.generateReleaseManifest(), null, 2)}\n`
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
