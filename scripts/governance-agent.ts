#!/usr/bin/env -S pnpm tsx

import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  isAddressEqual,
  keccak256,
  stringToHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { merkleGovModuleAbi } from '../frontend/lib/contract-abis'

type VoteName = 'no' | 'yes' | 'abstain'
type Decision = { vote: VoteName; analysis: string }

interface AgentConfig {
  rpcUrl: string
  indexerUrl: string
  module: Address
  principal: Address
  decisionsPath: string
  statePath: string
  receiptsPath: string
  notificationWebhook: string
  castLeadBlocks: number
  minNoticeBlocks: number
  pollSeconds: number
}

interface ProposalProgress {
  notifiedAtBlock?: string
  intendedDigest?: Hex
  status?:
    | 'cast'
    | 'preempted'
    | 'revoked'
    | 'expired'
    | 'cancelled'
    | 'executed'
    | 'missed-notice'
  transactionHash?: Hex
}

interface AgentState {
  proposals: Record<string, ProposalProgress>
}

const voteType = (vote: VoteName): number =>
  vote === 'no' ? 0 : vote === 'yes' ? 1 : 2

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

const withDigest = <T extends Record<string, unknown>>(receipt: T) => ({
  ...receipt,
  digest: keccak256(stringToHex(canonicalJson(receipt))),
})

const parseArgs = () => {
  const values = process.argv.slice(2)
  const configIndex = values.indexOf('--config')
  if (configIndex < 0 || !values[configIndex + 1]) {
    throw new Error('Usage: governance-agent --config <file> [--once|--test-notification]')
  }
  return {
    configPath: path.resolve(values[configIndex + 1]!),
    once: values.includes('--once'),
    testNotification: values.includes('--test-notification'),
  }
}

const requireInteger = (value: unknown, name: string, min: number, max: number) => {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  }
  return Number(value)
}

const loadConfig = async (configPath: string): Promise<AgentConfig> => {
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
  const base = path.dirname(configPath)
  if (
    typeof raw.rpcUrl !== 'string' ||
    typeof raw.indexerUrl !== 'string' ||
    typeof raw.module !== 'string' ||
    !isAddress(raw.module) ||
    typeof raw.principal !== 'string' ||
    !isAddress(raw.principal) ||
    typeof raw.decisionsPath !== 'string' ||
    typeof raw.statePath !== 'string' ||
    typeof raw.receiptsPath !== 'string' ||
    typeof raw.notificationWebhook !== 'string'
  ) {
    throw new Error('Agent config is missing a URL, address, or file path')
  }
  const notification = new URL(raw.notificationWebhook)
  if (
    notification.protocol !== 'https:' &&
    !(notification.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(notification.hostname))
  ) {
    throw new Error('notificationWebhook must use HTTPS (HTTP is allowed only on localhost)')
  }
  return {
    rpcUrl: raw.rpcUrl,
    indexerUrl: raw.indexerUrl.replace(/\/$/, ''),
    module: raw.module,
    principal: raw.principal,
    decisionsPath: path.resolve(base, raw.decisionsPath),
    statePath: path.resolve(base, raw.statePath),
    receiptsPath: path.resolve(base, raw.receiptsPath),
    notificationWebhook: notification.toString(),
    castLeadBlocks: requireInteger(raw.castLeadBlocks, 'castLeadBlocks', 1, 100_000),
    minNoticeBlocks: requireInteger(raw.minNoticeBlocks, 'minNoticeBlocks', 1, 100_000),
    pollSeconds: requireInteger(raw.pollSeconds, 'pollSeconds', 3, 300),
  }
}

const readJsonOr = async <T>(file: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

const loadDecisions = async (file: string): Promise<Record<string, Decision>> => {
  const raw = await readJsonOr<Record<string, unknown>>(file, {})
  const decisions: Record<string, Decision> = {}
  for (const [proposalId, value] of Object.entries(raw)) {
    if (!/^[1-9][0-9]*$/.test(proposalId) || !value || typeof value !== 'object') {
      throw new Error(`Invalid decision entry ${proposalId}`)
    }
    const row = value as Record<string, unknown>
    const analysis = typeof row.analysis === 'string' ? row.analysis.trim() : ''
    if (
      !['no', 'yes', 'abstain'].includes(String(row.vote)) ||
      analysis.length === 0 ||
      Buffer.byteLength(analysis, 'utf8') > 512
    ) {
      throw new Error(`Decision ${proposalId} needs vote no|yes|abstain and 1-512 analysis bytes`)
    }
    decisions[proposalId] = {
      vote: row.vote as VoteName,
      analysis,
    }
  }
  return decisions
}

const persistState = async (file: string, state: AgentState) => {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

const appendReceipt = async (file: string, receipt: Record<string, unknown>) => {
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(receipt)}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
}

const notify = async (webhook: string, receipt: Record<string, unknown>) => {
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(receipt),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Notification webhook returned ${response.status}`)
}

const main = async () => {
  const args = parseArgs()
  const config = await loadConfig(args.configPath)
  const privateKey = process.env.TRUSTGRAPHS_AGENT_PRIVATE_KEY
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('TRUSTGRAPHS_AGENT_PRIVATE_KEY must be a 32-byte hex private key')
  }
  const account = privateKeyToAccount(privateKey as Hex)
  if (isAddressEqual(account.address, config.principal)) {
    throw new Error('The agent key must differ from the principal')
  }

  const bootstrapClient = createPublicClient({ transport: http(config.rpcUrl) })
  const chainId = await bootstrapClient.getChainId()
  const chain = defineChain({
    id: chainId,
    name: 'Trustgraphs agent chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  })
  const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) })
  const walletClient = createWalletClient({ account, chain, transport: http(config.rpcUrl) })

  if (args.testNotification) {
    const receipt = withDigest({
      kind: 'notification-test',
      chainId,
      module: config.module,
      principal: config.principal,
      delegate: account.address,
      createdAt: new Date().toISOString(),
    })
    await notify(config.notificationWebhook, receipt)
    process.stdout.write(`notification delivered: ${receipt.digest}\n`)
    return
  }

  const configuredDelegate = await publicClient.readContract({
    address: config.module,
    abi: merkleGovModuleAbi,
    functionName: 'voteDelegate',
    args: [config.principal],
  })
  if (!isAddressEqual(configuredDelegate, account.address)) {
    throw new Error(`Agent ${account.address} is not the configured delegate for ${config.principal}`)
  }

  const runOnce = async () => {
    const [blockNumber, proposalCount, snapshot] = await Promise.all([
      publicClient.getBlockNumber(),
      publicClient.readContract({
        address: config.module,
        abi: merkleGovModuleAbi,
        functionName: 'proposalCount',
      }),
      publicClient.readContract({
        address: config.module,
        abi: merkleGovModuleAbi,
        functionName: 'merkleSnapshotContract',
      }),
    ])
    const decisions = await loadDecisions(config.decisionsPath)
    const state = await readJsonOr<AgentState>(config.statePath, { proposals: {} })

    const recordResult = async (proposalId: string, progress: ProposalProgress) => {
      if (!progress.status) return
      const result = withDigest({
        kind: 'intended-vote-result',
        result: progress.status,
        intendedDigest: progress.intendedDigest ?? null,
        chainId,
        module: config.module,
        proposalId,
        principal: config.principal,
        delegate: account.address,
        transactionHash: progress.transactionHash ?? null,
        observedBlock: blockNumber.toString(),
        createdAt: new Date().toISOString(),
      })
      await notify(config.notificationWebhook, result)
      await appendReceipt(config.receiptsPath, result)
      // Persist each terminal result immediately so a later proposal failure cannot duplicate it.
      await persistState(config.statePath, state)
    }

    for (let id = 1n; id <= proposalCount; id += 1n) {
      const key = id.toString()
      const decision = decisions[key]
      const progress = (state.proposals[key] ??= {})
      if (progress.status || !decision) continue

      const [proposal] = await publicClient.readContract({
        address: config.module,
        abi: merkleGovModuleAbi,
        functionName: 'getProposal',
        args: [id],
      })
      if (proposal.cancelled) {
        progress.status = 'cancelled'
        await recordResult(key, progress)
        continue
      }
      if (proposal.executed) {
        progress.status = 'executed'
        await recordResult(key, progress)
        continue
      }
      if (blockNumber < proposal.startBlock) continue
      if (blockNumber > proposal.endBlock) {
        progress.status = 'expired'
        await recordResult(key, progress)
        continue
      }

      const configuredCastBlock =
        proposal.endBlock > BigInt(config.castLeadBlocks) &&
        proposal.endBlock - BigInt(config.castLeadBlocks) > proposal.startBlock
          ? proposal.endBlock - BigInt(config.castLeadBlocks)
          : proposal.startBlock

      if (!progress.intendedDigest) {
        const latestNoticeBlock =
          proposal.endBlock > BigInt(config.minNoticeBlocks)
            ? proposal.endBlock - BigInt(config.minNoticeBlocks)
            : proposal.startBlock
        if (blockNumber > latestNoticeBlock) {
          progress.status = 'missed-notice'
          const missed = withDigest({
            kind: 'vote-skipped',
            cause: 'minimum-notice-window-missed',
            chainId,
            module: config.module,
            proposalId: key,
            principal: config.principal,
            delegate: account.address,
            observedBlock: blockNumber.toString(),
            createdAt: new Date().toISOString(),
          })
          await notify(config.notificationWebhook, missed)
          await appendReceipt(config.receiptsPath, missed)
          await persistState(config.statePath, state)
          continue
        }
        const intended = withDigest({
          kind: 'intended-vote',
          chainId,
          module: config.module,
          proposalId: key,
          principal: config.principal,
          delegate: account.address,
          proposalRoot: proposal.merkleRoot,
          proposalTitle: proposal.title,
          proposalDescription: proposal.description,
          intendedVote: decision.vote,
          analysis: decision.analysis,
          observedBlock: blockNumber.toString(),
          plannedCastBlock: (
            configuredCastBlock > blockNumber + BigInt(config.minNoticeBlocks)
              ? configuredCastBlock
              : blockNumber + BigInt(config.minNoticeBlocks)
          ).toString(),
          createdAt: new Date().toISOString(),
        })
        // No notification, no vote: delivery must succeed before durable state advances.
        await notify(config.notificationWebhook, intended)
        await appendReceipt(config.receiptsPath, intended)
        progress.notifiedAtBlock = blockNumber.toString()
        progress.intendedDigest = intended.digest
        await persistState(config.statePath, state)
      }

      if (!progress.notifiedAtBlock || !/^(0|[1-9][0-9]*)$/.test(progress.notifiedAtBlock)) {
        throw new Error(`Proposal ${key} has an invalid persisted notification block`)
      }
      const noticeSatisfiedAt = BigInt(progress.notifiedAtBlock) + BigInt(config.minNoticeBlocks)
      const castAt = configuredCastBlock > noticeSatisfiedAt ? configuredCastBlock : noticeSatisfiedAt
      if (blockNumber < castAt) continue

      const [alreadyVoted, currentDelegate] = await Promise.all([
        publicClient.readContract({
          address: config.module,
          abi: merkleGovModuleAbi,
          functionName: 'hasVoted',
          args: [id, config.principal],
        }),
        publicClient.readContract({
          address: config.module,
          abi: merkleGovModuleAbi,
          functionName: 'voteDelegate',
          args: [config.principal],
        }),
      ])
      if (alreadyVoted) {
        const [delegated, caster] = await Promise.all([
          publicClient.readContract({
            address: config.module,
            abi: merkleGovModuleAbi,
            functionName: 'votedByDelegate',
            args: [id, config.principal],
          }),
          publicClient.readContract({
            address: config.module,
            abi: merkleGovModuleAbi,
            functionName: 'delegateVoter',
            args: [id, config.principal],
          }),
        ])
        progress.status =
          delegated && isAddressEqual(caster, account.address)
            ? 'cast'
            : 'preempted'
      } else if (!isAddressEqual(currentDelegate, account.address)) {
        progress.status = 'revoked'
      } else {
        const proofResponse = await fetch(
          `${config.indexerUrl}/merkle/${snapshot}/${proposal.merkleRoot}/${config.principal}`,
          { signal: AbortSignal.timeout(15_000) }
        )
        if (!proofResponse.ok) {
          throw new Error(`Merkle proof endpoint returned ${proofResponse.status} for proposal ${key}`)
        }
        const { entry } = (await proofResponse.json()) as {
          entry?: { value: string; proof: Hex[] }
        }
        if (
          !entry ||
          !/^(0|[1-9][0-9]*)$/.test(entry.value) ||
          !Array.isArray(entry.proof) ||
          !entry.proof.every((node) => /^0x[0-9a-fA-F]{64}$/.test(node))
        ) {
          throw new Error(`Invalid merkle proof response for proposal ${key}`)
        }
        const hash = await walletClient.writeContract({
          account,
          chain,
          address: config.module,
          abi: merkleGovModuleAbi,
          functionName: 'castVoteAsDelegate',
          args: [
            config.principal,
            id,
            voteType(decision.vote),
            BigInt(entry.value),
            entry.proof,
            decision.analysis,
          ],
        })
        const transaction = await publicClient.waitForTransactionReceipt({ hash })
        if (transaction.status !== 'success') throw new Error(`Delegate vote ${hash} reverted`)
        progress.status = 'cast'
        progress.transactionHash = hash
      }

      await recordResult(key, progress)
    }
    await persistState(config.statePath, state)
  }

  do {
    await runOnce()
    if (args.once) break
    await new Promise((resolve) => setTimeout(resolve, config.pollSeconds * 1000))
  } while (true)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
