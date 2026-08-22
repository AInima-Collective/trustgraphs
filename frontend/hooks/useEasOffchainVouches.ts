'use client'

import {
  type DraftOperation,
  type LiveNodeHead,
  type PayloadV1,
  type SignedAnchorBundle,
  type WalletTypedDataSigner,
  ZERO32,
  applyOperations,
  assertSyncedBeforeEdit,
  buildNextMessage,
  createSignedBundle,
  domainSeparator,
  exportBundle,
  randomAttestationSalt,
  signEasV2Attestation,
  validateSignedBundle,
} from '@trustgraphs/eas-offchain-client'
import { useCallback, useMemo, useState } from 'react'
import { type Address, type Hex, getAddress } from 'viem'
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSignTypedData,
} from 'wagmi'

import {
  type StrictLaneConfig,
  canonicalStrictNode,
  easOffchainRelayUrls,
  fetchExactOffchainPayload,
  readStrictHistory,
  readStrictLaneConfig,
  readStrictNode,
} from '@/lib/eas-offchain'
import { parseErrorMessage } from '@/lib/error'
import type { Network } from '@/lib/types'

export type OffchainAttestReview = {
  kind: 'attest'
  version: 2
  chainId: bigint
  eas: Address
  easVersion: string
  registry: Address
  owner: Address
  schema: Hex
  recipient: Address
  time: bigint
  expirationTime: 0n
  revocable: true
  refUID: Hex
  data: Hex
  salt: Hex
}

export type OffchainHeadReview = {
  kind: 'head'
  operation: 'attest' | 'revoke'
  nodeId: Hex
  envelopeKind: 0
  schemaUid: Hex
  previousHead: Hex
  head: Hex
  count: bigint
  dataCommitment: Hex
  cid: string
}

export type OffchainTimelineEntry = {
  kind: 'attest' | 'revoke'
  uid: Hex
  recipient: Address
  time: bigint
  data: Hex
  sequence: number
  active: boolean
}

export type OffchainSubmissionAudit = {
  registry: Address
  nodeId: Hex
  count: string
  head: Hex
  dataCommitment: Hex
  cid: string
  localBundleVerified: true
  finalizedIndexerVerified: true
}

type PendingHead = {
  review: OffchainHeadReview
  operation: DraftOperation
  payload: PayloadV1
  live: LiveNodeHead
  lane: StrictLaneConfig
}

type RelayFailure = {
  code?: string
  message?: string
  retryable?: boolean
  action?: 'none' | 'retry' | 'reload'
  details?: Record<string, unknown>
}

const relayFailure = async (response: Response): Promise<RelayFailure> => {
  const body = (await response.json().catch(() => null)) as {
    error?: RelayFailure
  } | null
  return body?.error ?? { message: `Relay responded ${response.status}` }
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const sameLive = (left: LiveNodeHead, right: LiveNodeHead): boolean =>
  left.count === right.count &&
  left.head.toLowerCase() === right.head.toLowerCase() &&
  left.dataCommitment.toLowerCase() === right.dataCommitment.toLowerCase()

const entryBodyMap = (payload: PayloadV1) =>
  new Map(
    payload.attestations.map((attestation) => [
      attestation.uid.toLowerCase(),
      attestation,
    ])
  )

const actionableRelayError = (failure: RelayFailure): string => {
  if (failure.code === 'PROJECTED_WORK') {
    return 'This append would exceed the network’s immutable proof-work cap. Use on-chain EAS in another network or ask the DAO to start a new network; this cap cannot be raised.'
  }
  if (failure.action === 'reload') {
    return 'Another append won the race. The canonical payload has been reloaded; review and sign the refreshed head.'
  }
  if (failure.retryable || failure.action === 'retry') {
    return `${failure.message ?? 'The relay is temporarily unavailable'} Retry this recoverable bundle, or submit it to another configured relay.`
  }
  return failure.message ?? 'The relay rejected the signed bundle.'
}

export const useEasOffchainVouches = (network?: Network) => {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const { signTypedDataAsync } = useSignTypedData()
  const registry = network?.offchainLane?.registry
  const schemaUid = network?.schemas.find(
    (schema) => schema.key === 'vouching'
  )?.uid

  const [attestReview, setAttestReview] = useState<OffchainAttestReview | null>(
    null
  )
  const [pendingHead, setPendingHead] = useState<PendingHead | null>(null)
  const [phase, setPhase] = useState<
    | 'idle'
    | 'loading-canonical'
    | 'review-attestation'
    | 'signing-attestation'
    | 'review-head'
    | 'signing-head'
    | 'relay-storage'
    | 'anchored-awaiting-finality'
    | 'anchored-unverified'
    | 'verified'
  >('idle')
  const [error, setError] = useState<string | null>(null)
  const [bundle, setBundle] = useState<SignedAnchorBundle | null>(null)
  const [audit, setAudit] = useState<OffchainSubmissionAudit | null>(null)
  const [timeline, setTimeline] = useState<OffchainTimelineEntry[]>([])

  const wallet = useMemo<WalletTypedDataSigner | undefined>(
    () =>
      address
        ? {
            address,
            signTypedData: (args) => signTypedDataAsync(args as never),
          }
        : undefined,
    [address, signTypedDataAsync]
  )

  const ensureLane = useCallback(async () => {
    if (!isConnected || !address || !wallet || !publicClient) {
      throw new Error('Connect an EOA wallet before editing this strict log.')
    }
    if (!registry || !schemaUid || !network?.offchainLane) {
      throw new Error(
        'This network does not have a strict off-chain vouch lane.'
      )
    }
    const code = await publicClient.getCode({ address })
    if (code && code !== '0x') {
      throw new Error(
        'Strict off-chain vouches support EOAs only. This account has contract code, so use the unchanged on-chain EAS path instead.'
      )
    }
    const lane = await readStrictLaneConfig(registry)
    if (
      getAddress(lane.registry) !== getAddress(registry) ||
      lane.schemaUid.toLowerCase() !== schemaUid.toLowerCase() ||
      BigInt(lane.chainId) !== BigInt(chainId) ||
      lane.maxTotalInputs !== network.offchainLane.maxTotalInputs
    ) {
      throw new Error(
        'The finalized strict-lane configuration does not match this network catalog. Refresh before signing.'
      )
    }
    const computedDomain = domainSeparator({
      name: 'EAS Attestation',
      version: lane.easVersion,
      chainId: BigInt(lane.chainId),
      verifyingContract: getAddress(lane.eas),
    })
    if (
      computedDomain.toLowerCase() !== lane.domainSeparator.toLowerCase() ||
      computedDomain.toLowerCase() !==
        network.offchainLane.easDomainSeparator.toLowerCase()
    ) {
      throw new Error(
        'The browser’s independently computed EAS domain does not match the factory-authenticated lane.'
      )
    }
    if (BigInt(lane.workCount) + 5n > BigInt(lane.maxTotalInputs)) {
      throw new Error(
        'This network has reached its immutable proof-work cap. No strict append can be anchored.'
      )
    }
    return { lane, owner: getAddress(address), wallet }
  }, [
    address,
    chainId,
    isConnected,
    network,
    publicClient,
    registry,
    schemaUid,
    wallet,
  ])

  const refreshTimeline = useCallback(async () => {
    if (!registry || !schemaUid || !address) {
      setTimeline([])
      return []
    }
    try {
      const canonical = await canonicalStrictNode({
        registry,
        owner: getAddress(address),
        schemaUid,
      })
      if (!canonical.payload || !canonical.node) {
        setTimeline([])
        return []
      }
      const history = (await readStrictHistory(registry, canonical.node.nodeId))
        .filter((anchor) => anchor.verified)
        .sort((left, right) =>
          BigInt(left.foldIndex) < BigInt(right.foldIndex)
            ? -1
            : BigInt(left.foldIndex) > BigInt(right.foldIndex)
              ? 1
              : 0
        )
      const bodies = entryBodyMap(canonical.payload)
      const active = new Set<string>()
      const rows = canonical.payload.entries.map((entry, sequence) => {
        const body = bodies.get(entry.uid.toLowerCase())
        if (!body) throw new Error(`Strict entry ${entry.uid} has no body.`)
        const firstAnchor = history.find(
          (anchor) => BigInt(anchor.count) > BigInt(sequence)
        )
        if (!firstAnchor) {
          throw new Error(`Strict entry ${entry.uid} has no commit anchor.`)
        }
        if (entry.kind === 0) active.add(entry.uid.toLowerCase())
        else active.delete(entry.uid.toLowerCase())
        return {
          kind: entry.kind === 0 ? ('attest' as const) : ('revoke' as const),
          uid: entry.uid,
          recipient: body.recipient,
          time:
            entry.kind === 0 ? body.time : BigInt(firstAnchor.blockTimestamp),
          data: body.data,
          sequence,
          active: false,
        }
      })
      for (const row of rows) {
        row.active = row.kind === 'attest' && active.has(row.uid.toLowerCase())
      }
      setTimeline(rows)
      return rows
    } catch (timelineError) {
      setError(parseErrorMessage(timelineError))
      return []
    }
  }, [address, registry, schemaUid])

  const reset = useCallback(() => {
    setAttestReview(null)
    setPendingHead(null)
    setBundle(null)
    setAudit(null)
    setError(null)
    setPhase('idle')
  }, [])

  const prepareAttest = useCallback(
    async (input: { recipient: Address; data: Hex }) => {
      setError(null)
      setAudit(null)
      setBundle(null)
      setPhase('loading-canonical')
      try {
        const { lane, owner } = await ensureLane()
        await canonicalStrictNode({
          registry: lane.registry,
          owner,
          schemaUid: lane.schemaUid,
        })
        const latestBlock = await publicClient!.getBlock({ blockTag: 'latest' })
        const review: OffchainAttestReview = {
          kind: 'attest',
          version: 2,
          chainId: BigInt(lane.chainId),
          eas: getAddress(lane.eas),
          easVersion: lane.easVersion,
          registry: getAddress(lane.registry),
          owner,
          schema: lane.schemaUid,
          recipient: getAddress(input.recipient),
          // Consensus forbids a signed time after its first anchor. Using finalized chain time
          // avoids relying on a browser clock that may run ahead of the relay's chain.
          time: latestBlock.timestamp,
          expirationTime: 0n,
          revocable: true,
          refUID: ZERO32,
          data: input.data,
          salt: randomAttestationSalt(),
        }
        setAttestReview(review)
        setPendingHead(null)
        setPhase('review-attestation')
      } catch (prepareError) {
        setError(parseErrorMessage(prepareError))
        setPhase('idle')
        throw prepareError
      }
    },
    [ensureLane, publicClient]
  )

  const prepareHead = useCallback(
    async (operation: DraftOperation, operationKind: 'attest' | 'revoke') => {
      const { lane, owner } = await ensureLane()
      const canonical = await canonicalStrictNode({
        registry: lane.registry,
        owner,
        schemaUid: lane.schemaUid,
      })
      const payload = applyOperations(canonical.payload, owner, [operation])
      const next = buildNextMessage(payload, lane.schemaUid, canonical.live)
      setPendingHead({
        operation,
        payload,
        live: canonical.live,
        lane,
        review: {
          kind: 'head',
          operation: operationKind,
          ...next.message,
          cid: next.cid,
        },
      })
      setAttestReview(null)
      setPhase('review-head')
    },
    [ensureLane]
  )

  const signAttestation = useCallback(async () => {
    if (!attestReview) return
    setError(null)
    setPhase('signing-attestation')
    try {
      const { wallet } = await ensureLane()
      const attestation = await signEasV2Attestation(
        {
          schema: attestReview.schema,
          recipient: attestReview.recipient,
          time: attestReview.time,
          data: attestReview.data,
          salt: attestReview.salt,
        },
        {
          address: attestReview.eas,
          version: attestReview.easVersion,
          chainId: attestReview.chainId,
        },
        wallet
      )
      await prepareHead({ kind: 'attest', attestation }, 'attest')
    } catch (signError) {
      setError(parseErrorMessage(signError))
      setPhase('review-attestation')
      throw signError
    }
  }, [attestReview, ensureLane, prepareHead])

  const prepareRevoke = useCallback(
    async (uid: Hex) => {
      setError(null)
      setAudit(null)
      setBundle(null)
      setPhase('loading-canonical')
      try {
        await prepareHead({ kind: 'revoke', uid }, 'revoke')
      } catch (prepareError) {
        setError(parseErrorMessage(prepareError))
        setPhase('idle')
        throw prepareError
      }
    },
    [prepareHead]
  )

  const refreshAfterConflict = useCallback(
    async (operation: DraftOperation, operationKind: 'attest' | 'revoke') => {
      await prepareHead(operation, operationKind)
      setError(
        'Another append won the same-count race. The app reloaded the exact canonical CID and reapplied your signed operation. Review and sign the refreshed head; do not reuse the old head signature.'
      )
    },
    [prepareHead]
  )

  const waitForFinalizedVerification = useCallback(
    async (signed: SignedAnchorBundle) => {
      const expectedCount = BigInt(signed.message.count)
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const node = await readStrictNode(
          getAddress(signed.registry),
          getAddress(signed.owner)
        )
        if (
          node?.verified &&
          BigInt(node.count) === expectedCount &&
          node.head.toLowerCase() === signed.message.head.toLowerCase() &&
          node.dataCommitment.toLowerCase() ===
            signed.dataCommitment.toLowerCase()
        ) {
          await fetchExactOffchainPayload(signed.dataCommitment)
          await validateSignedBundle(signed)
          return node
        }
        await sleep(2_000)
      }
      return undefined
    },
    []
  )

  const verifyFinalizedBundle = useCallback(
    async (signed: SignedAnchorBundle): Promise<boolean> => {
      setPhase('anchored-awaiting-finality')
      const finalized = await waitForFinalizedVerification(signed)
      if (!finalized) {
        setPhase('anchored-unverified')
        setError(
          'The relay accepted and anchored this exact bundle, but it is not final and independently verified in the indexer yet. Keep the export and retry verification later; do not treat it as counted yet.'
        )
        return false
      }
      setAudit({
        registry: getAddress(signed.registry),
        nodeId: signed.message.nodeId,
        count: signed.message.count,
        head: signed.message.head,
        dataCommitment: signed.dataCommitment,
        cid: signed.cid,
        localBundleVerified: true,
        finalizedIndexerVerified: true,
      })
      setError(null)
      setPhase('verified')
      await refreshTimeline()
      return true
    },
    [refreshTimeline, waitForFinalizedVerification]
  )

  const retryFinalizedVerification = useCallback(async () => {
    if (!bundle) return
    setError(null)
    await verifyFinalizedBundle(bundle)
  }, [bundle, verifyFinalizedBundle])

  const signHeadAndSubmit = useCallback(async () => {
    if (!pendingHead) return
    setError(null)
    setPhase('signing-head')
    try {
      const { owner, wallet } = await ensureLane()
      const canonical = await canonicalStrictNode({
        registry: pendingHead.lane.registry,
        owner,
        schemaUid: pendingHead.lane.schemaUid,
      })
      if (!sameLive(canonical.live, pendingHead.live)) {
        await refreshAfterConflict(
          pendingHead.operation,
          pendingHead.review.operation
        )
        return
      }
      assertSyncedBeforeEdit(
        {
          protocol: 'TrustgraphsEasOffchainDraftV1',
          chainId: pendingHead.lane.chainId,
          registry: pendingHead.lane.registry,
          schemaUid: pendingHead.lane.schemaUid,
          owner,
          base: pendingHead.live,
          operations: [pendingHead.operation],
          createdAt: new Date().toISOString(),
        },
        canonical.live
      )
      const signed = await createSignedBundle({
        payload: pendingHead.payload,
        live: pendingHead.live,
        schemaUid: pendingHead.lane.schemaUid,
        eas: {
          address: getAddress(pendingHead.lane.eas),
          version: pendingHead.lane.easVersion,
          chainId: BigInt(pendingHead.lane.chainId),
        },
        registry: getAddress(pendingHead.lane.registry),
        wallet,
      })
      await validateSignedBundle(signed)
      setBundle(signed)
      setPhase('relay-storage')

      const relays = easOffchainRelayUrls()
      if (relays.length === 0) {
        throw new Error(
          'No public strict-lane relay is configured. Export this recoverable bundle and submit it to an admitted relay.'
        )
      }
      let accepted = false
      let lastFailure: RelayFailure | undefined
      for (const relay of relays) {
        let response: Response
        try {
          response = await fetch(`${relay}/v1/anchors`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(signed),
          })
        } catch (relayNetworkError) {
          lastFailure = {
            message: parseErrorMessage(relayNetworkError),
            retryable: true,
            action: 'retry',
          }
          continue
        }
        if (response.ok) {
          accepted = true
          break
        }
        const failure = await relayFailure(response)
        lastFailure = failure
        if (response.status === 409 || failure.action === 'reload') {
          await refreshAfterConflict(
            pendingHead.operation,
            pendingHead.review.operation
          )
          return
        }
        if (!failure.retryable && failure.action !== 'retry') break
      }
      if (!accepted) {
        throw new Error(actionableRelayError(lastFailure ?? {}))
      }

      setPendingHead(null)
      await verifyFinalizedBundle(signed)
    } catch (submitError) {
      setError(parseErrorMessage(submitError))
      if (bundle || pendingHead) setPhase('review-head')
      else setPhase('idle')
      throw submitError
    }
  }, [
    bundle,
    ensureLane,
    pendingHead,
    refreshAfterConflict,
    verifyFinalizedBundle,
  ])

  return {
    enabled: !!registry,
    phase,
    error,
    attestReview,
    headReview: pendingHead?.review ?? null,
    bundle,
    bundleExport: bundle ? exportBundle(bundle) : null,
    audit,
    timeline,
    prepareAttest,
    signAttestation,
    prepareRevoke,
    signHeadAndSubmit,
    retryFinalizedVerification,
    refreshTimeline,
    reset,
    isBusy: [
      'loading-canonical',
      'signing-attestation',
      'signing-head',
      'relay-storage',
      'anchored-awaiting-finality',
    ].includes(phase),
  }
}
