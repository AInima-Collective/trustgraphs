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
    '-e, --env <env>',
    'The deploy environment (dev or prod) (default: $DEPLOY_ENV from .env)'
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

const main = async () => {
  const context = initProgram(program)
  const {
    env,
    options: { fundedKey },
  } = context

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
        FUNDED_KEY: fundedKey,
      },
      shell: true,
    })

    await contract.postRun?.(context)

    console.log(chalk.yellowBright(`✅ ${contract.name} deployed`))
  }

  await env.postDeployContracts?.()

  fs.writeFileSync(
    DEPLOYMENT_SUMMARY_FILE,
    JSON.stringify(env.generateDeploymentSummary(), null, 2)
  )

  console.log(
    chalk.greenBright(
      '🎉 All contracts deployed successfully! Deployment summary saved to .docker/deployment_summary.json'
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
