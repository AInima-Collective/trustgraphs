/**
 * Discovery — the trust-graph catalog, built from the chain (GOAL.md M2;
 * research/INSTANCE_FACTORY.md §3).
 *
 * `TrustgraphsFactory.InstanceCreated` is the frozen interface every consumer reconstructs an
 * instance from: the hosted prover (registry → addresses, event → params), third parties auditing
 * what a community actually computes, and this indexer. One handler turns it into one `instance`
 * row, and the same event is what Ponder's `factory()` sources use to discover the instance's
 * snapshot / resolver / distributor (packages/indexer/ponder.config.ts) — so "the row exists" and "that
 * network's attestations are being indexed" are the same fact, with no config edit and no restart
 * between the transaction and the network being live.
 */
import { domainSeparator, headDomain } from '@trustgraphs/eas-offchain-client'
import { ponder } from 'ponder:registry'
import { easOffchainLane, instance, merkleFundDistributor } from 'ponder:schema'
import { type Hex, zeroAddress } from 'viem'

import { revalidateNetwork } from './utils'
import { paramsHash } from '../../frontend/lib/pagerank/encode'
import {
  easOffchainAnchorRegistryAbi,
  easVersionAbi,
} from '../abis/easOffchainAnchorRegistry'
import { trustgraphsFactoryAbi } from '../abis/trustgraphsFactory'

/**
 * The full 17-field params struct as stored/served: every field that is a bigint on-chain
 * (uint256/uint64) is a decimal string so the JSON round-trips losslessly; the two uint32s stay
 * numbers. Field names and order mirror `ParamsCodec.Params` exactly.
 */
export type InstanceParamsJson = {
  dampingFp: string
  toleranceFp: string
  maxIterations: number
  minWeightFp: string
  maxWeightFp: string
  trustShareFp: string
  trustDecayFp: string
  trustedSeeds: Hex[]
  totalPool: string
  precisionScale: string
  schemaUid: Hex
  weightFieldIndex: number
  envelope0DomainSeparators: Hex[]
  lane2MaxHeadAge: string
  /** Params-schema v2 domain separation: the instance's own accumulator … */
  accumulator: Hex
  /** … and the chain it was created on. Together they stop clones cross-feeding proofs. */
  chainId: string
}

type OnchainInstanceParams = {
  dampingFp: bigint
  toleranceFp: bigint
  maxIterations: number
  minWeightFp: bigint
  maxWeightFp: bigint
  trustShareFp: bigint
  trustDecayFp: bigint
  trustedSeeds: readonly Hex[]
  totalPool: bigint
  precisionScale: bigint
  schemaUid: Hex
  weightFieldIndex: number
  envelope0DomainSeparators: readonly Hex[]
  lane2MaxHeadAge: bigint
  accumulator: Hex
  chainId: bigint
}

/** Serialize and hash one exact-width tuple without rescaling or losing integer precision. */
export const normalizeInstanceParams = (params: OnchainInstanceParams) => {
  const trustedSeeds = [...params.trustedSeeds]
  const envelope0DomainSeparators = [...params.envelope0DomainSeparators]
  const paramsJson: InstanceParamsJson = {
    dampingFp: params.dampingFp.toString(),
    toleranceFp: params.toleranceFp.toString(),
    maxIterations: params.maxIterations,
    minWeightFp: params.minWeightFp.toString(),
    maxWeightFp: params.maxWeightFp.toString(),
    trustShareFp: params.trustShareFp.toString(),
    trustDecayFp: params.trustDecayFp.toString(),
    trustedSeeds,
    totalPool: params.totalPool.toString(),
    precisionScale: params.precisionScale.toString(),
    schemaUid: params.schemaUid,
    weightFieldIndex: params.weightFieldIndex,
    envelope0DomainSeparators,
    lane2MaxHeadAge: params.lane2MaxHeadAge.toString(),
    accumulator: params.accumulator,
    chainId: params.chainId.toString(),
  }
  const hash = paramsHash({
    ...params,
    trustedSeeds,
    envelope0DomainSeparators,
  })
  return { paramsJson, trustedSeeds, hash }
}

/** The canonical vouch schema, used if the on-chain constant can't be read (it is a constant). */
const CANONICAL_VOUCH_SCHEMA = 'string comment,uint256 confidence'

/**
 * Resolve `metadataURI` to its presentation blob. Best effort by design: nothing in it is
 * consensus-relevant, so an unreachable gateway must leave the instance indexed and renderable
 * (name, addresses and params all come from the event) rather than wedge the indexer.
 */
export const fetchMetadata = async (
  metadataURI: string
): Promise<unknown | null> => {
  if (!metadataURI) return null

  let url: string
  if (metadataURI.startsWith('ipfs://')) {
    const gateway = process.env.IPFS_GATEWAY
    if (!gateway) return null
    // Use 127.0.0.1 instead of localhost to avoid subdomain redirects (as in src/merkle.ts).
    url = (gateway + metadataURI.slice('ipfs://'.length)).replace(
      'localhost',
      '127.0.0.1'
    )
  } else if (
    metadataURI.startsWith('http://') ||
    metadataURI.startsWith('https://')
  ) {
    url = metadataURI
  } else {
    return null
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) {
      console.warn(
        `factory: metadata fetch ${url} -> ${response.status} ${response.statusText}`
      )
      return null
    }
    return await response.json()
  } catch (error) {
    console.warn(`factory: metadata fetch ${url} failed:`, error)
    return null
  }
}

ponder.on('trustgraphsFactory:InstanceCreated', async ({ event, context }) => {
  const {
    instanceId,
    creator,
    admin,
    name,
    metadataURI,
    resolver,
    schemaUid,
    snapshot,
    distributor,
    distributorToken,
    epochLength,
    params,
  } = event.args

  const { paramsJson, trustedSeeds, hash } = normalizeInstanceParams(params)

  let schemaString = CANONICAL_VOUCH_SCHEMA
  try {
    schemaString = await context.client.readContract({
      address: event.log.address,
      abi: trustgraphsFactoryAbi,
      functionName: 'VOUCH_SCHEMA',
    })
  } catch (error) {
    console.warn(
      'factory: VOUCH_SCHEMA read failed, using the constant:',
      error
    )
  }

  const metadata = await fetchMetadata(metadataURI)

  console.log(
    `factory: InstanceCreated ${instanceId} "${name}" @ block ${event.block.number} snapshot ${snapshot} resolver ${resolver}`
  )

  await context.db.insert(instance).values({
    id: instanceId,
    factory: event.log.address,
    chainId: `${context.chain.id}`,
    creator,
    admin,
    name,
    metadataURI,
    metadata,
    resolver,
    schemaUid,
    schemaString,
    snapshot,
    distributor: distributor === zeroAddress ? null : distributor,
    distributorToken:
      distributorToken === zeroAddress ? null : distributorToken,
    epochLength,
    paramsHash: hash,
    params: paramsJson,
    trustedSeeds,
    createdBlock: event.block.number,
    createdTimestamp: event.block.timestamp,
    createdTxHash: event.transaction.hash,
  })

  // Seed the distributor's config row from its birth state instead of reading it back in a `setup`
  // handler. The factory constructs it with `owner = feeRecipient = admin`, no fee, no allowlist
  // and unpaused, so this is exact — and it means the first `Distributed`/`Paused`/… event for a
  // brand-new instance can never arrive before the row it updates.
  if (distributor !== zeroAddress) {
    await context.db
      .insert(merkleFundDistributor)
      .values({
        address: distributor,
        chainId: `${context.chain.id}`,
        paused: false,
        merkleSnapshot: snapshot,
        owner: admin,
        pendingOwner: zeroAddress,
        feeRecipient: admin,
        feePercentage: '0',
        allowlistEnabled: false,
        allowlist: [],
      })
      .onConflictDoNothing()
  }

  await revalidateNetwork(instanceId)
})

ponder.on(
  'trustgraphsFactory:OffchainEasLaneCreated',
  async ({ event, context }) => {
    const {
      instanceId,
      registry,
      domainSeparator: easDomain,
      maxTotalInputs,
    } = event.args
    const catalog = await context.db.find(instance, { id: instanceId })
    if (!catalog) {
      console.error(
        `factory: strict lane ${registry} has no preceding instance ${instanceId}; refusing discovery`
      )
      return
    }
    const params = catalog.params as InstanceParamsJson
    const [paramsEasDomain, paramsHeadDomain] = params.envelope0DomainSeparators
    if (
      params.envelope0DomainSeparators.length !== 2 ||
      !paramsEasDomain ||
      !paramsHeadDomain ||
      paramsEasDomain.toLowerCase() !== easDomain.toLowerCase()
    ) {
      console.error(
        `factory: strict lane ${registry} domain does not match authenticated instance params`
      )
      return
    }
    const eas = await context.client.readContract({
      address: registry,
      abi: easOffchainAnchorRegistryAbi,
      functionName: 'EAS',
      blockNumber: event.block.number,
    })
    const easVersion = await context.client.readContract({
      address: eas,
      abi: easVersionAbi,
      functionName: 'version',
      blockNumber: event.block.number,
    })
    const chainId = BigInt(context.chain.id)
    const computedEasDomain = domainSeparator({
      name: 'EAS Attestation',
      version: easVersion,
      chainId,
      verifyingContract: eas,
    })
    const computedHeadDomain = domainSeparator(headDomain(chainId, registry))
    if (
      computedEasDomain.toLowerCase() !== easDomain.toLowerCase() ||
      computedHeadDomain.toLowerCase() !== paramsHeadDomain.toLowerCase()
    ) {
      console.error(
        `factory: strict lane ${registry} EAS/head domains do not reproduce the factory tuple`
      )
      return
    }

    await context.db.insert(easOffchainLane).values({
      registry,
      instanceId,
      factory: event.log.address,
      chainId: `${context.chain.id}`,
      eas,
      easVersion,
      schemaUid: catalog.schemaUid,
      domainSeparator: easDomain,
      headDomainSeparator: paramsHeadDomain,
      maxTotalInputs,
      anchorCount: 0n,
      aggregateEntryCount: 0n,
      workCount: 0n,
      validationFailures: 0n,
      lastAnchorBlock: null,
      lastVerifiedBlock: null,
      createdBlock: event.block.number,
      createdTimestamp: event.block.timestamp,
      createdTxHash: event.transaction.hash,
    })
    await context.db.update(instance, { id: instanceId }).set({
      offchainRegistry: registry,
      offchainEasDomainSeparator: easDomain,
      offchainMaxTotalInputs: maxTotalInputs,
    })
  }
)
