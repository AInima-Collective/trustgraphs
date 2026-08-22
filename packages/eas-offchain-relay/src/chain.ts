import type {
  AnchorMessage,
  LiveNodeHead,
  SignedAnchorBundle,
} from '@trustgraphs/eas-offchain-client'
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { LaneState, RelayChain } from './types.ts'

const registryAbi = parseAbi([
  'function EAS() view returns (address)',
  'function schemaUid() view returns (bytes32)',
  'function maxTotalInputs() view returns (uint64)',
  'function easDomainSeparator() view returns (bytes32)',
  'function headDomainSeparator() view returns (bytes32)',
  'function snapshot() view returns (address)',
  'function workCount() view returns (uint64)',
  'function anchorCount() view returns (uint64)',
  'function registered(bytes32) view returns (bool)',
  'function ownerOf(bytes32) view returns (address)',
  'function lastCount(bytes32) view returns (uint64)',
  'function lastHead(bytes32) view returns (bytes32)',
  'function lastDataCommitment(bytes32) view returns (bytes32)',
  'function anchor(bytes32 nodeId,uint8 envelopeKind,bytes32 previousHead,bytes32 head,uint64 count,bytes32 dataCommitment,bytes headSignature)',
])
const easAbi = parseAbi(['function version() view returns (string)'])
const snapshotAbi = parseAbi(['function accumulator() view returns (address)'])
const accumulatorAbi = parseAbi(['function leafCount() view returns (uint64)'])

export class ViemRelayChain implements RelayChain {
  private readonly publicClient
  private readonly walletClient
  private readonly account

  constructor(
    rpcUrl: string,
    private readonly registry: Address,
    relayerPrivateKey: Hex
  ) {
    this.publicClient = createPublicClient({ transport: http(rpcUrl) })
    this.account = privateKeyToAccount(relayerPrivateKey)
    this.walletClient = createWalletClient({
      account: this.account,
      transport: http(rpcUrl),
    })
  }

  private async nodeLive(nodeId: Hex): Promise<LiveNodeHead> {
    const [count, head, dataCommitment] = await Promise.all([
      this.publicClient.readContract({
        address: this.registry,
        abi: registryAbi,
        functionName: 'lastCount',
        args: [nodeId],
      }),
      this.publicClient.readContract({
        address: this.registry,
        abi: registryAbi,
        functionName: 'lastHead',
        args: [nodeId],
      }),
      this.publicClient.readContract({
        address: this.registry,
        abi: registryAbi,
        functionName: 'lastDataCommitment',
        args: [nodeId],
      }),
    ])
    return { count, head, dataCommitment }
  }

  async lane(nodeId: Hex): Promise<LaneState> {
    const [
      chainId,
      easAddress,
      schemaUid,
      maxTotalInputs,
      easDomainSeparator,
      headDomainSeparator,
      snapshot,
      workCount,
      anchorCount,
      registered,
      owner,
      live,
      latestBlock,
    ] = await Promise.all([
      this.publicClient.getChainId(),
      this.publicClient.readContract({
        address: this.registry,
        abi: registryAbi,
        functionName: 'EAS',
      }),
      this.publicClient.readContract({
        address: this.registry,
        abi: registryAbi,
        functionName: 'schemaUid',
      }),
      this.publicClient.readContract({
        address: this.registry,
        abi: registryAbi,
        functionName: 'maxTotalInputs',
      }),
      this.publicClient.readContract({
        address: this.registry,
        abi: registryAbi,
        functionName: 'easDomainSeparator',
      }),
      this.publicClient.readContract({
        address: this.registry,
        abi: registryAbi,
        functionName: 'headDomainSeparator',
      }),
      this.publicClient.readContract({
        address: this.registry,
        abi: registryAbi,
        functionName: 'snapshot',
      }),
      this.publicClient.readContract({
        address: this.registry,
        abi: registryAbi,
        functionName: 'workCount',
      }),
      this.publicClient.readContract({
        address: this.registry,
        abi: registryAbi,
        functionName: 'anchorCount',
      }),
      this.publicClient.readContract({
        address: this.registry,
        abi: registryAbi,
        functionName: 'registered',
        args: [nodeId],
      }),
      this.publicClient.readContract({
        address: this.registry,
        abi: registryAbi,
        functionName: 'ownerOf',
        args: [nodeId],
      }),
      this.nodeLive(nodeId),
      this.publicClient.getBlock({ blockTag: 'latest' }),
    ])
    const [easVersion, accumulator] = await Promise.all([
      this.publicClient.readContract({
        address: easAddress,
        abi: easAbi,
        functionName: 'version',
      }),
      this.publicClient.readContract({
        address: snapshot,
        abi: snapshotAbi,
        functionName: 'accumulator',
      }),
    ])
    const lane1LeafCount = await this.publicClient.readContract({
      address: accumulator,
      abi: accumulatorAbi,
      functionName: 'leafCount',
    })
    return {
      chainId: BigInt(chainId),
      registry: this.registry,
      easAddress: getAddress(easAddress),
      easVersion,
      schemaUid,
      easDomainSeparator,
      headDomainSeparator,
      maxTotalInputs,
      anchorCount,
      workCount,
      lane1LeafCount,
      latestBlockTimestamp: latestBlock.timestamp,
      live,
      ...(registered && owner !== zeroAddress
        ? { registeredOwner: getAddress(owner) }
        : {}),
    }
  }

  live(nodeId: Hex): Promise<LiveNodeHead> {
    return this.nodeLive(nodeId)
  }

  private args(message: AnchorMessage, signature: Hex) {
    return [
      message.nodeId,
      message.envelopeKind,
      message.previousHead,
      message.head,
      message.count,
      message.dataCommitment,
      signature,
    ] as const
  }

  async simulate(
    bundle: SignedAnchorBundle,
    message: AnchorMessage
  ): Promise<void> {
    await this.publicClient.simulateContract({
      account: this.account,
      address: this.registry,
      abi: registryAbi,
      functionName: 'anchor',
      args: this.args(message, bundle.headSignature),
    })
  }

  async anchor(
    bundle: SignedAnchorBundle,
    message: AnchorMessage
  ): Promise<void> {
    const simulation = await this.publicClient.simulateContract({
      account: this.account,
      address: this.registry,
      abi: registryAbi,
      functionName: 'anchor',
      args: this.args(message, bundle.headSignature),
    })
    const hash = await this.walletClient.writeContract(simulation.request)
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success')
      throw new Error('anchor transaction reverted')
  }
}
