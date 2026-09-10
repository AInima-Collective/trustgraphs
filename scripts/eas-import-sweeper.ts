#!/usr/bin/env -S pnpm tsx

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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
  parseAbi,
  parseAbiItem,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

interface Config {
  rpcUrl: string
  importer: Address
  snapshot?: Address
  startBlock: bigint
  confirmations: bigint
  logBlockRange: bigint
  batchSize: number
  statePath: string
}

interface SweeperState {
  version: 1
  chainId: number
  eas: Address
  importer: Address
  schemaUid: Hex
  nextBlock: string
  coverageThroughBlock: string | null
  futureExpirations: Array<{ uid: Hex; timestamp: string }>
}

const importerAbi = parseAbi([
  'function EAS() view returns (address)',
  'function schemaUid() view returns (bytes32)',
  'function attestationsProcessed(bytes32) view returns (bool)',
  'function revocationsProcessed(bytes32) view returns (bool)',
  'function expirationsProcessed(bytes32) view returns (bool)',
  'function importAttestations(bytes32[]) returns (uint256,uint256)',
  'function importRevocations(bytes32[]) returns (uint256,uint256)',
  'function importExpirations(bytes32[]) returns (uint256,uint256)',
])
const easAbi = parseAbi([
  'function getAttestation(bytes32) view returns ((bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))',
])
const snapshotAbi = parseAbi(['function trigger() returns (uint256)'])
const attestedEvent = parseAbiItem(
  'event Attested(address indexed recipient,address indexed attester,bytes32 uid,bytes32 indexed schemaUID)'
)
const revokedEvent = parseAbiItem(
  'event Revoked(address indexed recipient,address indexed attester,bytes32 uid,bytes32 indexed schemaUID)'
)

const parseArgs = () => {
  const args = process.argv.slice(2)
  const configAt = args.indexOf('--config')
  if (configAt < 0 || !args[configAt + 1]) {
    throw new Error(
      'Usage: eas-import-sweeper --config <file> [--trigger] [--dry-run]'
    )
  }
  return {
    configPath: path.resolve(args[configAt + 1]!),
    trigger: args.includes('--trigger'),
    dryRun: args.includes('--dry-run'),
  }
}

const integer = (value: unknown, name: string, min: number, max: number) => {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  ) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  }
  return Number(value)
}

const loadConfig = async (file: string): Promise<Config> => {
  const raw = JSON.parse(await readFile(file, 'utf8')) as Record<
    string,
    unknown
  >
  if (
    typeof raw.rpcUrl !== 'string' ||
    typeof raw.importer !== 'string' ||
    !isAddress(raw.importer) ||
    (raw.snapshot !== undefined &&
      (typeof raw.snapshot !== 'string' || !isAddress(raw.snapshot)))
  ) {
    throw new Error(
      'config requires rpcUrl, importer, and an optional snapshot address'
    )
  }
  return {
    rpcUrl: raw.rpcUrl,
    importer: raw.importer,
    snapshot: raw.snapshot as Address | undefined,
    startBlock: BigInt(
      integer(raw.startBlock ?? 0, 'startBlock', 0, Number.MAX_SAFE_INTEGER)
    ),
    confirmations: BigInt(
      integer(raw.confirmations ?? 2, 'confirmations', 0, 1_000)
    ),
    logBlockRange: BigInt(
      integer(raw.logBlockRange ?? 2_000, 'logBlockRange', 1, 100_000)
    ),
    batchSize: integer(raw.batchSize ?? 32, 'batchSize', 1, 256),
    statePath: path.resolve(
      path.dirname(file),
      String(raw.statePath ?? './eas-import-state.json')
    ),
  }
}

const readState = async (file: string): Promise<SweeperState | null> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as SweeperState
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const persist = async (file: string, state: SweeperState) => {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  })
  await rename(temporary, file)
}

const chunks = <T>(values: T[], size: number): T[][] => {
  const result: T[][] = []
  for (let i = 0; i < values.length; i += size)
    result.push(values.slice(i, i + size))
  return result
}

const unique = (uids: readonly Hex[]) => [
  ...new Map(uids.map((uid) => [uid.toLowerCase(), uid])).values(),
]

const main = async () => {
  const args = parseArgs()
  const config = await loadConfig(args.configPath)
  const privateKey = process.env.TRUSTGRAPHS_EAS_IMPORTER_PRIVATE_KEY
  if (
    !args.dryRun &&
    (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey))
  ) {
    throw new Error(
      'TRUSTGRAPHS_EAS_IMPORTER_PRIVATE_KEY must be a 32-byte hex private key'
    )
  }

  const bootstrap = createPublicClient({ transport: http(config.rpcUrl) })
  const chainId = await bootstrap.getChainId()
  const chain = defineChain({
    id: chainId,
    name: 'Trustgraphs EAS import chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  })
  const publicClient = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  })
  const account = privateKey
    ? privateKeyToAccount(privateKey as Hex)
    : undefined
  const walletClient = account
    ? createWalletClient({ account, chain, transport: http(config.rpcUrl) })
    : undefined
  const [eas, schemaUid] = await Promise.all([
    publicClient.readContract({
      address: config.importer,
      abi: importerAbi,
      functionName: 'EAS',
      authorizationList: undefined,
    }),
    publicClient.readContract({
      address: config.importer,
      abi: importerAbi,
      functionName: 'schemaUid',
      authorizationList: undefined,
    }),
  ])
  const existing = await readState(config.statePath)
  if (
    existing &&
    (existing.version !== 1 ||
      existing.chainId !== chainId ||
      !isAddressEqual(existing.eas, eas) ||
      !isAddressEqual(existing.importer, config.importer) ||
      existing.schemaUid.toLowerCase() !== schemaUid.toLowerCase())
  ) {
    throw new Error(
      'state file belongs to a different chain/EAS/importer/schema tuple'
    )
  }
  const state: SweeperState = existing ?? {
    version: 1,
    chainId,
    eas,
    importer: config.importer,
    schemaUid,
    nextBlock: config.startBlock.toString(),
    coverageThroughBlock: null,
    futureExpirations: [],
  }

  const submit = async (
    functionName:
      | 'importAttestations'
      | 'importRevocations'
      | 'importExpirations',
    uids: Hex[]
  ) => {
    for (const batch of chunks(unique(uids), config.batchSize)) {
      const simulation = await publicClient.simulateContract({
        account: account?.address,
        address: config.importer,
        abi: importerAbi,
        functionName,
        args: [batch],
      })
      if (args.dryRun) {
        process.stdout.write(`[dry-run] ${functionName} ${batch.length}\n`)
        continue
      }
      const hash = await walletClient!.writeContract(simulation.request)
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success')
        throw new Error(`${functionName} transaction ${hash} reverted`)
      process.stdout.write(`${functionName} ${batch.length}: ${hash}\n`)
    }
  }

  const unprocessed = async (
    functionName:
      | 'attestationsProcessed'
      | 'revocationsProcessed'
      | 'expirationsProcessed',
    uids: Hex[]
  ) => {
    const deduplicated = unique(uids)
    const values = await Promise.all(
      deduplicated.map((uid) =>
        publicClient.readContract({
          address: config.importer,
          abi: importerAbi,
          functionName,
          args: [uid],
          authorizationList: undefined,
        })
      )
    )
    return deduplicated.filter((_, index) => !values[index])
  }

  const syncRange = async (fromBlock: bigint, toBlock: bigint) => {
    const [attested, revoked] = await Promise.all([
      publicClient.getLogs({
        address: eas,
        event: attestedEvent,
        args: { schemaUID: schemaUid },
        fromBlock,
        toBlock,
      }),
      publicClient.getLogs({
        address: eas,
        event: revokedEvent,
        args: { schemaUID: schemaUid },
        fromBlock,
        toBlock,
      }),
    ])
    const attestationUids = attested.flatMap((log) =>
      log.args.uid ? [log.args.uid] : []
    )
    const revocationUids = revoked.flatMap((log) =>
      log.args.uid ? [log.args.uid] : []
    )
    const pendingAttestations = await unprocessed(
      'attestationsProcessed',
      attestationUids
    )
    await submit('importAttestations', pendingAttestations)
    const pendingRevocations = await unprocessed(
      'revocationsProcessed',
      revocationUids
    )
    await submit('importRevocations', pendingRevocations)

    if (attestationUids.length > 0) {
      const records = await Promise.all(
        unique(attestationUids).map((uid) =>
          publicClient.readContract({
            address: eas,
            abi: easAbi,
            functionName: 'getAttestation',
            args: [uid],
            authorizationList: undefined,
          })
        )
      )
      const known = new Map(
        state.futureExpirations.map((entry) => [entry.uid.toLowerCase(), entry])
      )
      records.forEach((record) => {
        if (record.expirationTime > 0n) {
          known.set(record.uid.toLowerCase(), {
            uid: record.uid,
            timestamp: record.expirationTime.toString(),
          })
        }
      })
      state.futureExpirations = [...known.values()]
    }

    const now = BigInt(Math.floor(Date.now() / 1_000))
    const due = state.futureExpirations
      .filter((entry) => BigInt(entry.timestamp) <= now)
      .map((entry) => entry.uid)
    const pendingExpirations = await unprocessed('expirationsProcessed', due)
    await submit('importExpirations', pendingExpirations)
    const processedDue = new Set(due.map((uid) => uid.toLowerCase()))
    state.futureExpirations = state.futureExpirations.filter(
      (entry) => !processedDue.has(entry.uid.toLowerCase())
    )
  }

  const latest = await publicClient.getBlockNumber()
  const target =
    latest > config.confirmations ? latest - config.confirmations : 0n
  let cursor = BigInt(state.nextBlock)
  while (cursor <= target) {
    const end =
      cursor + config.logBlockRange - 1n < target
        ? cursor + config.logBlockRange - 1n
        : target
    await syncRange(cursor, end)
    if (args.dryRun) break
    state.nextBlock = (end + 1n).toString()
    state.coverageThroughBlock = end.toString()
    await persist(config.statePath, state)
    process.stdout.write(`coverage through block ${end}\n`)
    cursor = end + 1n
  }

  if (args.trigger) {
    if (!config.snapshot)
      throw new Error('--trigger requires snapshot in the config')
    if (args.dryRun) {
      process.stdout.write(`[dry-run] trigger ${config.snapshot}\n`)
    } else {
      // Close the confirmation lag for a checkpoint run. The resulting receipt reports the exact
      // pre-trigger EAS watermark; attestations landing concurrently remain visibly pending for the
      // next sweep rather than being misrepresented as covered.
      const head = await publicClient.getBlockNumber()
      if (BigInt(state.nextBlock) <= head) {
        await syncRange(BigInt(state.nextBlock), head)
        state.nextBlock = (head + 1n).toString()
        state.coverageThroughBlock = head.toString()
        await persist(config.statePath, state)
      }
      const simulation = await publicClient.simulateContract({
        account: account!.address,
        address: config.snapshot,
        abi: snapshotAbi,
        functionName: 'trigger',
      })
      const hash = await walletClient!.writeContract(simulation.request)
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success')
        throw new Error(`trigger transaction ${hash} reverted`)
      process.stdout.write(
        `checkpoint triggered: ${hash}; canonical EAS coverage through block ${state.coverageThroughBlock}\n`
      )
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  )
  process.exitCode = 1
})
