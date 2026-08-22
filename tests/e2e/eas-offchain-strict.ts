import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { SchemaEncoder } from '@ethereum-attestation-service/eas-sdk'
import {
  applyOperations,
  createSignedBundle,
  domainSeparator,
  equalBytes,
  headDomain,
  hexToBytes,
  signEasV2Attestation,
  validateSignedBundle,
  ZERO32,
  type LiveNodeHead,
  type SignedAnchorBundle,
  type WalletTypedDataSigner,
} from '@trustgraphs/eas-offchain-client'
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const deploymentPath = required('EAS_OFFCHAIN_E2E_DEPLOY_FILE')
const rpcUrl = process.env.RPC ?? 'http://127.0.0.1:18545'
const relayUrls = required('EAS_OFFCHAIN_E2E_RELAYS').split(',')
const gatewayUrls = required('EAS_OFFCHAIN_E2E_GATEWAYS').split(',')
const outputPath = required('EAS_OFFCHAIN_E2E_OUTPUT_FILE')
const deployerKey = required('EAS_OFFCHAIN_E2E_DEPLOYER_KEY') as Hex

assert.ok(relayUrls.length >= 2, 'two independent relays are required')
assert.ok(
  gatewayUrls.length >= 2,
  'two independent raw-CID readers are required'
)

type Deployment = {
  chain_id: number
  factory: Address
  instance_id: Hex
  instance_registry: Address
  eas: Address
  schema_uid: Hex
  snapshot: Address
  resolver: Address
}

const factoryLaneEvent = parseAbiItem(
  'event OffchainEasLaneCreated(bytes32 indexed instanceId,address registry,bytes32 domainSeparator,uint64 maxTotalInputs)'
)
const laneAbi = parseAbi([
  'function EAS() view returns (address)',
  'function schemaUid() view returns (bytes32)',
  'function easDomainSeparator() view returns (bytes32)',
  'function headDomainSeparator() view returns (bytes32)',
  'function maxTotalInputs() view returns (uint64)',
  'function ANCHORER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32,address) view returns (bool)',
  'function ownerOf(bytes32) view returns (address)',
  'function lastCount(bytes32) view returns (uint64)',
  'function lastHead(bytes32) view returns (bytes32)',
  'function lastDataCommitment(bytes32) view returns (bytes32)',
  'function anchorCount() view returns (uint64)',
  'function workCount() view returns (uint64)',
])
const directoryAbi = parseAbi([
  'function getInstance(bytes32) view returns ((bytes32 program,address snapshot,address verifier,address registryOrAccumulator,bytes32 paramsHash))',
])
const easAbi = parseAbi([
  'function version() view returns (string)',
  'function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data)) payable returns (bytes32)',
])
const snapshotAbi = parseAbi([
  'function anchorRegistry() view returns (address)',
])

const publicClient = createPublicClient({ transport: http(rpcUrl) })
const deployer = privateKeyToAccount(deployerKey)
const walletClient = createWalletClient({
  account: deployer,
  transport: http(rpcUrl),
})
const typedWallet: WalletTypedDataSigner = {
  address: deployer.address,
  signTypedData: (args) => deployer.signTypedData(args as never),
}

const readLive = async (
  registry: Address,
  nodeId: Hex
): Promise<LiveNodeHead> => {
  const [count, head, dataCommitment] = await Promise.all([
    publicClient.readContract({
      address: registry,
      abi: laneAbi,
      functionName: 'lastCount',
      args: [nodeId],
    }),
    publicClient.readContract({
      address: registry,
      abi: laneAbi,
      functionName: 'lastHead',
      args: [nodeId],
    }),
    publicClient.readContract({
      address: registry,
      abi: laneAbi,
      functionName: 'lastDataCommitment',
      args: [nodeId],
    }),
  ])
  return { count, head, dataCommitment }
}

const submitToBothRelays = async (bundle: SignedAnchorBundle) => {
  const responses = await Promise.all(
    relayUrls.map((relay) =>
      fetch(`${relay.replace(/\/$/, '')}/v1/anchors`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bundle),
      })
    )
  )
  const bodies = await Promise.all(responses.map((response) => response.json()))
  for (const [index, response] of responses.entries()) {
    assert.equal(
      response.status,
      200,
      `relay ${relayUrls[index]} rejected bundle: ${JSON.stringify(bodies[index])}`
    )
  }
  assert.deepEqual(bodies[0], bodies[1], 'racing relays did not converge')
  return bodies[0]
}

const assertEveryReader = async (bundle: SignedAnchorBundle) => {
  const expected = hexToBytes(bundle.payloadHex)
  for (const gateway of gatewayUrls) {
    const response = await fetch(`${gateway}${bundle.cid}`)
    assert.equal(response.status, 200, `${gateway} cannot read ${bundle.cid}`)
    assert.equal(
      equalBytes(new Uint8Array(await response.arrayBuffer()), expected),
      true,
      `${gateway} returned corrupt bytes for ${bundle.cid}`
    )
  }
}

const waitForChainTime = async (minimum: bigint): Promise<bigint> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const block = await publicClient.getBlock({ blockTag: 'latest' })
    if (block.timestamp >= minimum) return block.timestamp
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`chain timestamp did not reach ${minimum}`)
}

const main = async () => {
  const deployment = JSON.parse(
    await readFile(deploymentPath, 'utf8')
  ) as Deployment
  const factory = getAddress(deployment.factory)
  const laneLogs = await publicClient.getLogs({
    address: factory,
    event: factoryLaneEvent,
    args: { instanceId: deployment.instance_id },
    fromBlock: 0n,
    toBlock: 'latest',
  })
  assert.equal(laneLogs.length, 1, 'factory lane discovery must be unique')
  const laneEvent = laneLogs[0]!.args
  const registry = getAddress(laneEvent.registry!)

  const [
    directory,
    snapshotRegistry,
    eas,
    schemaUid,
    easVersion,
    easSeparator,
    headSeparator,
  ] = await Promise.all([
    publicClient.readContract({
      address: deployment.instance_registry,
      abi: directoryAbi,
      functionName: 'getInstance',
      args: [deployment.instance_id],
    }),
    publicClient.readContract({
      address: deployment.snapshot,
      abi: snapshotAbi,
      functionName: 'anchorRegistry',
    }),
    publicClient.readContract({
      address: registry,
      abi: laneAbi,
      functionName: 'EAS',
    }),
    publicClient.readContract({
      address: registry,
      abi: laneAbi,
      functionName: 'schemaUid',
    }),
    publicClient.readContract({
      address: deployment.eas,
      abi: easAbi,
      functionName: 'version',
    }),
    publicClient.readContract({
      address: registry,
      abi: laneAbi,
      functionName: 'easDomainSeparator',
    }),
    publicClient.readContract({
      address: registry,
      abi: laneAbi,
      functionName: 'headDomainSeparator',
    }),
  ])
  assert.equal(getAddress(directory.snapshot), getAddress(deployment.snapshot))
  assert.equal(
    getAddress(directory.registryOrAccumulator),
    getAddress(deployment.resolver)
  )
  assert.equal(getAddress(snapshotRegistry), registry)
  assert.equal(getAddress(eas), getAddress(deployment.eas))
  assert.equal(schemaUid, deployment.schema_uid)
  assert.equal(laneEvent.domainSeparator, easSeparator)
  assert.equal(
    easSeparator,
    domainSeparator({
      name: 'EAS Attestation',
      version: easVersion,
      chainId: BigInt(deployment.chain_id),
      verifyingContract: getAddress(eas),
    })
  )
  assert.equal(
    headSeparator,
    domainSeparator(headDomain(BigInt(deployment.chain_id), registry))
  )
  assert.equal(
    await publicClient.getBytecode({ address: deployer.address }),
    undefined
  )

  const relayerRole = await publicClient.readContract({
    address: registry,
    abi: laneAbi,
    functionName: 'ANCHORER_ROLE',
  })
  for (const relayer of [
    getAddress(required('EAS_OFFCHAIN_E2E_RELAYER_A')),
    getAddress(required('EAS_OFFCHAIN_E2E_RELAYER_B')),
  ]) {
    assert.equal(
      await publicClient.readContract({
        address: registry,
        abi: laneAbi,
        functionName: 'hasRole',
        args: [relayerRole, relayer],
      }),
      true
    )
  }

  const recipient = getAddress('0x4444444444444444444444444444444444444444')
  const encoder = new SchemaEncoder('string comment,uint256 confidence')
  const onchainData = encoder.encodeData([
    { name: 'comment', type: 'string', value: 'lane one predecessor' },
    { name: 'confidence', type: 'uint256', value: 40n },
  ]) as Hex
  const onchain = await publicClient.simulateContract({
    account: deployer,
    address: getAddress(eas),
    abi: easAbi,
    functionName: 'attest',
    args: [
      {
        schema: schemaUid,
        data: {
          recipient,
          expirationTime: 0n,
          revocable: true,
          refUID: ZERO32,
          data: onchainData,
          value: 0n,
        },
      },
    ],
  })
  const onchainHash = await walletClient.writeContract(onchain.request)
  const onchainReceipt = await publicClient.waitForTransactionReceipt({
    hash: onchainHash,
  })
  assert.equal(onchainReceipt.status, 'success')

  const time = await waitForChainTime(
    (await publicClient.getBlock({ blockNumber: onchainReceipt.blockNumber }))
      .timestamp
  )
  const offchainData = encoder.encodeData([
    { name: 'comment', type: 'string', value: 'gasless replacement' },
    { name: 'confidence', type: 'uint256', value: 90n },
  ]) as Hex
  const attestation = await signEasV2Attestation(
    { schema: schemaUid, recipient, time, data: offchainData },
    {
      address: getAddress(eas),
      version: easVersion,
      chainId: BigInt(deployment.chain_id),
    },
    typedWallet
  )
  const firstPayload = applyOperations(undefined, deployer.address, [
    { kind: 'attest', attestation },
  ])
  const firstBundle = await createSignedBundle({
    payload: firstPayload,
    live: { count: 0n, head: ZERO32, dataCommitment: ZERO32 },
    schemaUid,
    eas: {
      address: getAddress(eas),
      version: easVersion,
      chainId: BigInt(deployment.chain_id),
    },
    registry,
    wallet: typedWallet,
  })
  await validateSignedBundle(firstBundle)
  await submitToBothRelays(firstBundle)
  await assertEveryReader(firstBundle)

  const live = await readLive(registry, firstBundle.message.nodeId)
  assert.equal(live.count, 1n)
  assert.equal(live.head, firstBundle.message.head)
  assert.equal(
    getAddress(
      await publicClient.readContract({
        address: registry,
        abi: laneAbi,
        functionName: 'ownerOf',
        args: [firstBundle.message.nodeId],
      })
    ),
    deployer.address
  )

  const revokePayload = applyOperations(firstPayload, deployer.address, [
    { kind: 'revoke', uid: attestation.uid },
  ])
  const revokeBundle = await createSignedBundle({
    payload: revokePayload,
    live,
    schemaUid,
    eas: {
      address: getAddress(eas),
      version: easVersion,
      chainId: BigInt(deployment.chain_id),
    },
    registry,
    wallet: typedWallet,
  })
  await validateSignedBundle(revokeBundle)
  await submitToBothRelays(revokeBundle)
  await Promise.all([
    assertEveryReader(firstBundle),
    assertEveryReader(revokeBundle),
  ])

  const finalLive = await readLive(registry, firstBundle.message.nodeId)
  assert.equal(finalLive.count, 2n)
  assert.equal(finalLive.head, revokeBundle.message.head)
  const [anchorCount, workCount] = await Promise.all([
    publicClient.readContract({
      address: registry,
      abi: laneAbi,
      functionName: 'anchorCount',
    }),
    publicClient.readContract({
      address: registry,
      abi: laneAbi,
      functionName: 'workCount',
    }),
  ])
  assert.equal(anchorCount, 2n)
  assert.equal(workCount, 10n)

  const output = {
    chainId: deployment.chain_id,
    instanceId: deployment.instance_id,
    factory,
    registry,
    snapshot: getAddress(deployment.snapshot),
    accumulator: getAddress(deployment.resolver),
    eas: getAddress(eas),
    schemaUid,
    onchainUid: onchain.result,
    nodeId: firstBundle.message.nodeId,
    firstCid: firstBundle.cid,
    firstCommitment: firstBundle.dataCommitment,
    revokeCid: revokeBundle.cid,
    revokeCommitment: revokeBundle.dataCommitment,
    anchorCount: anchorCount.toString(),
    workCount: workCount.toString(),
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`)
  process.stdout.write(
    `${JSON.stringify({ event: 'strict_eas_offchain_e2e', ...output })}\n`
  )
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  )
  process.exitCode = 1
})
