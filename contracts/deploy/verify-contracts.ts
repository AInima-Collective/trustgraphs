/**
 * Verify already-deployed contracts on the chain's block explorer.
 *
 * Usage:
 * ```
 * pnpm verify:contracts               # the deployment plan's contracts, on $DEPLOY_TARGET
 * pnpm verify:contracts --dry-run     # print what would be sent, call nothing
 * pnpm verify:contracts --all         # everything in broadcast/ for this chain
 * ```
 *
 * This is deliberately a separate pass rather than `--verify` on the deploy itself. The deploy
 * loop has no try/catch around a step, so an explorer rate-limit or a propagation delay on
 * contract two would abort contracts three through five *after* their predecessors had already
 * landed on-chain — trading a real deploy-day failure for a cosmetic one. Run after the fact and
 * the worst case is that verification is retried.
 *
 * It also takes no key and signs nothing: everything here is reads of local build output plus
 * HTTP to the explorer, so it cannot broadcast a transaction however it fails.
 *
 * Constructor arguments are recovered rather than remembered. A creation transaction's input is
 * the artifact's creation bytecode with the ABI-encoded arguments appended, so stripping the
 * known prefix leaves exactly the encoding the explorer wants. That beats
 * `--guess-constructor-args` (which asks the explorer to infer what we already know) and beats
 * threading the arguments out of the deploy scripts, which would be a second source able to
 * disagree with the chain.
 */

import fs from 'fs'
import path from 'path'

import chalk from 'chalk'
import { Command } from 'commander'

import { initProgram } from './env'
import { execFull } from './utils'

const program = new Command('verify-contracts')
  .description('Verify deployed contracts on the chain explorer')
  .option(
    '--stage <stage>',
    'Deployment stage: development or production (default: $DEPLOY_STAGE)'
  )
  .option(
    '--chain <target>',
    'Chain target: local or sepolia (default: $DEPLOY_TARGET)'
  )
  .option(
    '-r, --rpc-url <rpcUrl>',
    'The RPC URL for the chain (default: $RPC_URL from .env)'
  )
  .option(
    '--api-key <key>',
    'Explorer API key (default: $ETHERSCAN_API_KEY from .env)'
  )
  .option(
    '--all',
    'Verify every contract in broadcast/ for this chain, not only the deployment plan'
  )
  .option(
    '--dry-run',
    'Print what would be verified without calling the explorer'
  )

type BroadcastTransaction = {
  transactionType?: string
  contractName?: string
  contractAddress?: string
  transaction?: { input?: string }
}

type CreationRecord = {
  name: string
  address: string
  source: string
  constructorArgs: string
  script: string
}

/**
 * Find the one build artifact that declares `name`.
 *
 * `out/` holds a directory per source FILE, so a name alone is ambiguous whenever two files
 * declare the same contract — and it is also not the identifier the explorer wants, which is
 * `path/to/Source.sol:Name`. `metadata.settings.compilationTarget` is the artifact's own record
 * of which source it was compiled from, so it answers both questions at once and does not depend
 * on the directory layout staying what it is today.
 */
const resolveArtifact = (
  outDir: string,
  name: string
): { source: string; creationCode: string } | null => {
  const matches: { source: string; creationCode: string }[] = []
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(outDir, entry.name, `${name}.json`)
    if (!fs.existsSync(file)) continue
    let artifact: {
      bytecode?: { object?: string }
      metadata?: { settings?: { compilationTarget?: Record<string, string> } }
    }
    try {
      artifact = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    const target = artifact.metadata?.settings?.compilationTarget ?? {}
    const creationCode = artifact.bytecode?.object
    if (!creationCode) continue
    for (const [source, contract] of Object.entries(target)) {
      if (contract === name) matches.push({ source, creationCode })
    }
  }
  return matches.length === 1 ? matches[0] : null
}

const readCreations = (
  broadcastFile: string,
  outDir: string,
  scriptLabel: string
): { records: CreationRecord[]; problems: string[] } => {
  const records: CreationRecord[] = []
  const problems: string[] = []
  const run = JSON.parse(fs.readFileSync(broadcastFile, 'utf8')) as {
    transactions?: BroadcastTransaction[]
  }
  for (const tx of run.transactions ?? []) {
    if (tx.transactionType !== 'CREATE') continue
    const name = tx.contractName
    const address = tx.contractAddress
    const input = tx.transaction?.input
    if (!name || !address || !input) {
      problems.push(
        `${scriptLabel}: a CREATE record is missing name, address or input`
      )
      continue
    }
    const artifact = resolveArtifact(outDir, name)
    if (!artifact) {
      problems.push(
        `${name}: no single artifact in ${outDir} declares it — run \`forge build\` first, ` +
          `and if two sources declare the same contract, verify that one by hand`
      )
      continue
    }
    if (!input.toLowerCase().startsWith(artifact.creationCode.toLowerCase())) {
      // Not a warning to skip past: it means the local build is not the build that produced the
      // on-chain code, so anything this pass submitted for it would be wrong.
      problems.push(
        `${name}: the creation transaction does not start with this checkout's creation ` +
          `bytecode, so the deployed code was built from different sources or settings`
      )
      continue
    }
    records.push({
      name,
      address,
      source: artifact.source,
      constructorArgs: input.slice(artifact.creationCode.length),
      script: scriptLabel,
    })
  }
  return { records, problems }
}

const main = async () => {
  const context = initProgram(program)
  const {
    env,
    options: { apiKey, all, dryRun },
  } = context

  const explorer = env.profile.explorer
  if (!explorer) {
    throw new Error(
      `${env.profile.name} has no block explorer, so there is nothing to verify against`
    )
  }
  const key = apiKey || process.env.ETHERSCAN_API_KEY
  if (!key && !dryRun) {
    throw new Error(
      'ETHERSCAN_API_KEY must be set (or pass --api-key). Nothing else in the repo reads it.'
    )
  }

  const chainId = env.profile.chainId
  const outDir = 'out'
  if (!fs.existsSync(outDir)) {
    throw new Error(`${outDir}/ does not exist — run \`forge build\` first`)
  }

  // Verify what the deployment plan deploys, so this pass and the deploy cannot drift apart.
  // `--all` is the escape hatch for a chain that also carries older or hand-run deployments.
  const planned = env.deployContracts.map((contract) =>
    path.basename(contract.script.split(':')[0])
  )
  const scripts = all
    ? fs
        .readdirSync('broadcast', { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [...new Set(planned)]

  const records: CreationRecord[] = []
  const problems: string[] = []
  for (const script of scripts) {
    const file = path.join(
      'broadcast',
      script,
      String(chainId),
      'run-latest.json'
    )
    if (!fs.existsSync(file)) {
      if (!all) problems.push(`${script}: no broadcast for chain ${chainId}`)
      continue
    }
    const found = readCreations(file, outDir, script)
    records.push(...found.records)
    problems.push(...found.problems)
  }

  if (records.length === 0) {
    console.log(chalk.yellowBright(`Nothing to verify for chain ${chainId}.`))
    problems.forEach((problem) => console.log(chalk.gray(`  ${problem}`)))
    return
  }

  console.log(
    chalk.blueBright(
      `${records.length} contract${records.length === 1 ? '' : 's'} on ${env.profile.name} (${chainId})`
    )
  )
  for (const record of records) {
    console.log(
      `  ${record.address}  ${record.source}:${record.name}` +
        `  ${record.constructorArgs.length / 2} bytes of constructor args`
    )
  }

  if (dryRun) {
    console.log(chalk.greenBright('Dry run: no explorer calls were made.'))
    problems.forEach((problem) =>
      console.log(chalk.yellowBright(`  ${problem}`))
    )
    return
  }

  const failures: string[] = []
  for (const record of records) {
    console.log(chalk.blueBright(`\n🔍 ${record.name} at ${record.address}`))
    try {
      await execFull({
        cmd: [
          'forge',
          'verify-contract',
          record.address,
          `${record.source}:${record.name}`,
          '--chain',
          String(chainId),
          ...(record.constructorArgs
            ? ['--constructor-args', `0x${record.constructorArgs}`]
            : []),
          '--etherscan-api-key',
          '"$EXPLORER_API_KEY"',
          '--watch',
        ],
        log: 'all',
        env: { EXPLORER_API_KEY: key as string },
        shell: true,
      })
      console.log(chalk.greenBright(`✅ ${record.name}`))
    } catch (error) {
      // One contract failing to verify says nothing about the next, and none of it says
      // anything about the deployment, which already happened. Collect and continue.
      failures.push(`${record.name} (${record.address}): ${String(error)}`)
      console.log(chalk.redBright(`❌ ${record.name} — continuing`))
    }
  }

  console.log()
  for (const problem of problems)
    console.log(chalk.yellowBright(`⚠️  ${problem}`))
  for (const failure of failures) console.log(chalk.redBright(`❌ ${failure}`))
  const verified = records.length - failures.length
  console.log(
    chalk.greenBright(
      `${verified}/${records.length} verified. Browse them at ${explorer}/address/${records[records.length - 1].address}`
    )
  )
  if (failures.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(chalk.redBright(error instanceof Error ? error.message : error))
  process.exit(1)
})
