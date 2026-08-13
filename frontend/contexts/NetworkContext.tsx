'use client'

import { usePonderQueryOptions } from '@ponder/react'
import { useQuery } from '@tanstack/react-query'
import {
  Dispatch,
  ReactNode,
  SetStateAction,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { Hex, zeroAddress } from 'viem'
import { useAccount } from 'wagmi'

import { registerNetworks } from '@/components/schema-components/registerNetworks'
import { ENS_EAGER_ADDRESS_LIMIT, useBatchEnsQuery } from '@/hooks/useEns'
import { AttestationData, AttestationStatus } from '@/lib/attestation'
import { isTrustedSeed } from '@/lib/network'
import { simulateNetwork } from '@/lib/pagerank/simulate'
import { nullable } from '@/lib/ponder-query'
import {
  ScoreboardExportEntry,
  ScoreboardExportMetadata,
} from '@/lib/scoreboard-export'
import { Network, NetworkEntry } from '@/lib/types'
import { realAddress } from '@/lib/utils'
import { getCurrentChainConfig } from '@/lib/wagmi'
import { ponderQueries, ponderQueryFns } from '@/queries/ponder'

export type NetworkSimulationConfig = {
  enabled: boolean
  dampingFactor: number
  trustMultiplier: number
  trustShare: number
  trustDecay: number
  maxIterations: number
}

export type NetworkContextType = {
  // Network
  network: Network

  // Loading states
  isLoading: boolean
  /**
   * Loading state of the two reads that actually draw the graph: the latest
   * merkle tree and the network. Deliberately excludes the Gnosis Safe read.
   *
   * `isLoading` is the aggregate and stays that way, because a page that
   * displays the Safe's threshold has to wait for it. The landing page does not
   * display it, and against an unreachable indexer the Safe query retries four
   * times on an exponential ladder while the other two resolve immediately: the
   * hero's data was ready at 7.7s and the figure claimed to be loading until
   * 18.4s. Anything that only draws nodes and edges wants this one.
   */
  graphLoading: boolean
  error: string | null

  // Data
  accountData: NetworkEntry[]
  scoreboardExportData: ScoreboardExportEntry[]
  scoreboardExportMetadata: ScoreboardExportMetadata | undefined
  attestationsData: AttestationData[] | undefined
  totalValue: number
  totalParticipants: number
  averageValue: number
  medianValue: number
  gnosisSafe?: {
    address: Hex
    owners: Hex[]
    threshold: number
  }

  // Additional metadata from ponder
  merkleRoot: string | undefined
  ipfsHashCid: string | undefined
  blockNumber: string | undefined
  timestamp: string | undefined
  sources:
    | {
        name: string
        metadata: any
      }[]
    | undefined

  /** Refresh the network data. */
  refresh: () => Promise<void>

  /** Determine whether or not a given address is a trusted seed for the network. */
  isTrustedSeed: (address: string) => boolean

  /** The simulation config for the network. */
  simulationConfig: NetworkSimulationConfig
  /** Set the simulation config for the network. */
  setSimulationConfig: Dispatch<SetStateAction<NetworkSimulationConfig>>
}

export const NetworkContext = createContext<NetworkContextType | null>(null)

export const NetworkProvider = ({
  network,
  children,
}: {
  network: Network
  children: ReactNode
}) => {
  const { address: connectedAddress } = useAccount()
  // Make this network's vouch schema encodable and give it the vouching form, right now. The
  // server can resolve a factory instance (`lib/catalog.server.getNetwork`) faster than the
  // browser-side catalog query returns, and a page that renders a network must be able to attest
  // to it on its first paint, not one refetch later. Idempotent map writes.
  registerNetworks([network])

  // Fetch latest merkle tree with entries
  const {
    data: _merkleTreeData,
    isLoading: merkleLoading,
    error: merkleError,
    refetch: refetchMerkle,
  } = useQuery({
    ...ponderQueries.latestMerkleTree(network.contracts.merkleSnapshot),
    refetchInterval: 10_000,
  })

  // Fetch network
  const {
    data: _networkData,
    dataUpdatedAt: networkDataUpdatedAt,
    isLoading: networkLoading,
    error: networkError,
    refetch: refetchNetwork,
  } = useQuery({
    ...ponderQueries.network(network.contracts.merkleSnapshot),
    refetchInterval: 10_000,
  })

  // Fetch Gnosis Safe (if this network has one at all).
  //
  // `!!proxy` is not the right guard: a network created through the factory without a Safe still
  // carries `safe.proxy` in config, set to the ZERO address, and a zero-address string is truthy.
  // So the query ran, matched no row, and drizzle's `findFirst` resolved to `undefined` — which
  // TanStack Query rejects outright ("Query data cannot be undefined"), turning a network that
  // simply has no Safe into an error and a blank page.
  const safeProxy = realAddress(network.contracts.safe?.proxy)
  const {
    data: gnosisSafeData,
    isLoading: gnosisSafeLoading,
    refetch: refetchGnosisSafe,
    // `usePonderQueryOptions` + `useQuery` rather than `usePonderQuery`, so the result can go
    // through `nullable()`. `live` was already false here, which is all `usePonderQuery` adds.
  } = useQuery({
    ...nullable(
      usePonderQueryOptions(
        ponderQueryFns.getGnosisSafe(safeProxy ?? zeroAddress)
      )
    ),
    refetchInterval: 30_000,
    enabled: !!safeProxy,
  })

  // Refetch Gnosis Safe when network accounts length changes
  useEffect(() => {
    refetchGnosisSafe()
  }, [_networkData?.accounts.length])

  // Simulation config
  const [simulationConfig, setSimulationConfig] =
    useState<NetworkSimulationConfig>({
      enabled: false,
      dampingFactor: 0.85,
      trustMultiplier: 3,
      trustShare: 1,
      trustDecay: 0.8,
      maxIterations: 100,
    })

  // Local "what-if" simulation using the CANONICAL fixed-point PageRank (the exact TS mirror of
  // packages/pagerank-core / the zk guest). Recomputed synchronously — no WASM needed — so the
  // previewed scores and merkle root match, byte-for-byte, what a proof would commit.
  //
  // REDUCED parity tier (MULTI_PROGRAM_PLATFORM §6): this re-derives PageRank + the output root from
  // the edge set as served by the indexer; it does NOT re-verify EAS envelope signatures in TS
  // (envelope verification is in-guest). The lane-2 params are threaded in so `paramsHash` matches
  // on-chain, but the recomputed journal is lane-1-only — its `anchorAcc`/`anchorCount`/
  // `skippedDigest` are zero here. To verify the on-chain lane-2 accumulator, read
  // `AnchorRegistry.anchorAcc()/anchorCount()` or the `MerkleSnapshot.AnchorsCheckpointed` event.
  const simulation = useMemo(() => {
    if (!simulationConfig.enabled || !_networkData) {
      return null
    }

    try {
      return simulateNetwork(
        _networkData.attestations.map((attestation) => ({
          attester: attestation.attester,
          recipient: attestation.recipient,
          uid: attestation.uid,
          time: attestation.time,
          confidence: Number(attestation.decodedData?.confidence || 0),
          revoked: attestation.status === AttestationStatus.REVOKED,
        })),
        {
          dampingFactor: simulationConfig.dampingFactor,
          trustMultiplier: simulationConfig.trustMultiplier,
          trustShare: simulationConfig.trustShare,
          trustDecay: simulationConfig.trustDecay,
          maxIterations: simulationConfig.maxIterations,
          minWeight: network.pagerank.minWeight,
          maxWeight: network.pagerank.maxWeight,
          trustedSeeds: network.pagerank.trustedSeeds,
          // Catalog networks carry `totalPool` as a decimal string precisely because the on-chain
          // value (routinely 1e24) does not survive a JS number, and it is hashed into
          // `paramsHash` — rounding it here would make every simulated root wrong.
          pointsPool:
            typeof network.pagerank.pointsPool === 'string'
              ? BigInt(network.pagerank.pointsPool)
              : BigInt(Math.round(network.pagerank.pointsPool || 0)),
          // Lane-2 (envelope-0) params — threaded so the recomputed paramsHash matches the
          // on-chain, governance-pinned 17-field paramsHash for lane-2-enabled networks.
          envelope0DomainSeparators: network.pagerank.envelope0DomainSeparators,
          lane2MaxHeadAge: network.pagerank.lane2MaxHeadAge,
          // Params-schema v2 domain separation: this instance's accumulator + its chain. Without
          // them the recomputed paramsHash is some other instance's, which is the whole point.
          accumulator: network.contracts.easIndexerResolver,
          chainId: BigInt(getCurrentChainConfig().id),
          schemaUid: network.schemas.find((s) => s.key === 'vouching')?.uid,
        }
      )
    } catch (error) {
      console.error('error running pagerank simulation', error)
      return null
    }
  }, [
    simulationConfig,
    _networkData,
    network.pagerank.minWeight,
    network.pagerank.maxWeight,
    network.pagerank.trustedSeeds,
    network.pagerank.pointsPool,
    network.pagerank.envelope0DomainSeparators,
    network.pagerank.lane2MaxHeadAge,
  ])

  const simulatedResults = simulation?.results ?? null

  const simulatedEntries = useMemo(
    () =>
      simulation?.entries
        .map(({ account, value, proof }) => ({
          account,
          value: value.toString(),
          proof,
        }))
        .sort((a, b) =>
          BigInt(a.value) === BigInt(b.value)
            ? 0
            : BigInt(a.value) > BigInt(b.value)
              ? -1
              : 1
        ) ?? null,
    [simulation]
  )

  // Use simulated or real data based on the simulation config
  const { networkData, merkleTreeData } = useMemo((): {
    networkData: typeof _networkData
    merkleTreeData: typeof _merkleTreeData
  } => {
    if (!simulationConfig.enabled || !simulatedResults || !simulatedEntries) {
      return {
        networkData: _networkData,
        merkleTreeData: _merkleTreeData,
      }
    }

    console.log('simulatedResults:', simulatedResults)

    const networkData: typeof _networkData = _networkData && {
      accounts: _networkData.accounts.map((account) => ({
        ...account,
        value:
          simulatedResults[account.account.toLowerCase()]?.toString() || '0',
      })),
      attestations: _networkData.attestations,
    }

    const merkleTreeData: typeof _merkleTreeData = _merkleTreeData && {
      tree: {
        ..._merkleTreeData.tree,
        // Real canonical outputs from the fixed-point recompute (matches the zk guest).
        root: simulation?.outputRoot || '<simulated>',
        ipfsHash: simulation?.ipfsHash || '<simulated>',
        ipfsHashCid: simulation?.cid || '<simulated>',
        totalValue: (
          simulation?.totalValue ??
          networkData?.accounts.reduce(
            (acc, account) => acc + BigInt(account.value),
            0n
          ) ??
          0n
        ).toString(),
        blockNumber: '0',
        timestamp: '0',
      },
      entries: simulatedEntries,
    }

    return {
      networkData,
      merkleTreeData,
    }
  }, [
    simulationConfig.enabled,
    simulatedResults,
    simulatedEntries,
    simulation,
    _merkleTreeData,
    _networkData,
  ])

  // Resolve only the highest-ranked accounts eagerly. Address-first graph data
  // is never held up by ENS, and the graph consumes these names from this one owner.
  const ensAddresses = useMemo(() => {
    const ranked = [...(networkData?.accounts ?? [])].sort((a, b) =>
      BigInt(a.value) === BigInt(b.value)
        ? 0
        : BigInt(a.value) > BigInt(b.value)
          ? -1
          : 1
    )
    const connected = connectedAddress
      ? ranked.find(
          ({ account }) =>
            account.toLowerCase() === connectedAddress.toLowerCase()
        )
      : undefined
    return [
      ...(connected ? [connected] : []),
      ...ranked.filter((entry) => entry !== connected),
    ]
      .slice(0, ENS_EAGER_ADDRESS_LIMIT)
      .map(({ account }) => account)
  }, [connectedAddress, networkData])
  const { data: ensData } = useBatchEnsQuery(ensAddresses)

  // Transform network data to match the expected format
  const accountData = useMemo(() => {
    if (!networkData?.accounts?.length) {
      return []
    }

    const accountData = [...networkData.accounts]
      .sort((a, b) =>
        BigInt(a.value) === BigInt(b.value)
          ? 0
          : BigInt(a.value) > BigInt(b.value)
            ? -1
            : 1
      )
      .map((account, index: number): NetworkEntry => {
        const ensName =
          ensData?.[account.account.toLowerCase()]?.name || undefined

        return {
          ...account,
          ...(ensName ? { ensName } : {}),
          rank: index + 1,
        }
      })

    return accountData
  }, [networkData, ensData])

  // Scores and proofs must come from one response/root. The separately queried network endpoint is
  // used only to decorate those authoritative Merkle rows with live sent/received counts.
  const scoreboardExportData = useMemo<ScoreboardExportEntry[]>(() => {
    if (!merkleTreeData?.entries.length) return []

    const liveCounts = new Map(
      (_networkData?.accounts ?? []).map((entry) => [
        entry.account.toLowerCase(),
        { sent: entry.sent, received: entry.received },
      ])
    )
    return merkleTreeData.entries.map((entry) => ({
      account: entry.account,
      value: entry.value,
      proof: entry.proof,
      ...liveCounts.get(entry.account.toLowerCase()),
    }))
  }, [merkleTreeData, _networkData])

  const liveCountsFetchedAt = networkDataUpdatedAt
    ? new Date(networkDataUpdatedAt).toISOString()
    : undefined
  const scoreboardExportMetadata = useMemo<
    ScoreboardExportMetadata | undefined
  >(() => {
    if (!merkleTreeData?.tree.root) return undefined

    // If a requested simulation failed, do not offer a published export under a simulation-on UI.
    if (simulationConfig.enabled && !simulation) return undefined

    if (!simulationConfig.enabled) {
      return {
        mode: 'published',
        snapshot: network.contracts.merkleSnapshot,
        root: merkleTreeData.tree.root,
        ipfsHashCid: merkleTreeData.tree.ipfsHashCid,
        scoresAsOf: {
          blockNumber: merkleTreeData.tree.blockNumber,
          timestamp: merkleTreeData.tree.timestamp,
        },
        liveCountsFetchedAt,
      }
    }

    const schemaUid = network.schemas.find(
      (schema) => schema.key === 'vouching'
    )?.uid
    const referenceTree = _merkleTreeData?.tree
    return {
      mode: 'simulation',
      snapshot: network.contracts.merkleSnapshot,
      root: simulation.outputRoot,
      ipfsHashCid: simulation.cid,
      liveCountsFetchedAt,
      simulation: {
        kind: 'reduced-lane-1-browser-recompute',
        inputDataFetchedAt: liveCountsFetchedAt,
        referencePublishedRoot: referenceTree?.root,
        referencePublishedRootAsOf: referenceTree
          ? {
              blockNumber: referenceTree.blockNumber,
              timestamp: referenceTree.timestamp,
            }
          : undefined,
        params: {
          dampingFactor: simulationConfig.dampingFactor,
          trustMultiplier: simulationConfig.trustMultiplier,
          trustShare: simulationConfig.trustShare,
          trustDecay: simulationConfig.trustDecay,
          maxIterations: simulationConfig.maxIterations,
          minWeight: network.pagerank.minWeight,
          maxWeight: network.pagerank.maxWeight,
          trustedSeeds: network.pagerank.trustedSeeds,
          pointsPool: String(network.pagerank.pointsPool || 0),
          precisionScale: (10n ** 18n).toString(),
          schemaUid,
          accumulator: network.contracts.easIndexerResolver,
          chainId: getCurrentChainConfig().id.toString(),
          envelope0DomainSeparators: network.pagerank.envelope0DomainSeparators,
          lane2MaxHeadAge: network.pagerank.lane2MaxHeadAge,
        },
        paramsHash: simulation.journal.paramsHash,
        inputAccumulator: simulation.journal.acc,
        inputLeafCount: simulation.journal.leafCount.toString(),
      },
    }
  }, [
    merkleTreeData,
    simulationConfig,
    simulation,
    network,
    _merkleTreeData,
    liveCountsFetchedAt,
  ])

  // Calculate derived values
  const totalValue = Number(merkleTreeData?.tree?.totalValue || 0)
  const totalParticipants = merkleTreeData?.tree?.numAccounts || 0
  const averageValue =
    totalValue && totalParticipants
      ? Number(totalValue) / Number(totalParticipants)
      : 0
  const medianValue =
    accountData.length > 1
      ? Number(accountData[Math.ceil(accountData.length / 2)].value)
      : Number(accountData[0]?.value || 0)

  // Combined loading state
  const isLoading = merkleLoading || networkLoading || gnosisSafeLoading

  // The graph's own, without the Safe read folded in. See the type declaration
  // for why this is a second field rather than a change to the first.
  const graphLoading = merkleLoading || networkLoading

  // Combined error state
  const error = merkleError?.message || networkError?.message || null

  // Refresh function
  const refresh = useCallback(async () => {
    await Promise.all([refetchMerkle(), refetchNetwork()])
  }, [refetchMerkle, refetchNetwork])

  // Determine whether or not a given address is a trusted seed for the network
  const isTrustedNetworkSeed = useCallback(
    (address: string) => isTrustedSeed(network, address),
    [network.pagerank.trustedSeeds]
  )

  const value = {
    // Network
    network,

    // Loading states
    isLoading,
    graphLoading,
    error,

    // Data
    accountData,
    scoreboardExportData,
    scoreboardExportMetadata,
    attestationsData: networkData?.attestations,
    totalValue,
    totalParticipants,
    averageValue,
    medianValue,
    // `&&` would yield `null` here, and the context type says `| undefined`.
    gnosisSafe: gnosisSafeData
      ? {
          address: gnosisSafeData.address,
          owners: gnosisSafeData.owners,
          threshold: Number(gnosisSafeData.threshold),
        }
      : undefined,

    // Additional metadata from ponder
    merkleRoot: merkleTreeData?.tree?.root,
    ipfsHashCid: merkleTreeData?.tree?.ipfsHashCid,
    blockNumber: merkleTreeData?.tree?.blockNumber,
    timestamp: merkleTreeData?.tree?.timestamp,
    sources: merkleTreeData?.tree?.sources,

    // Actions
    refresh,

    // Utilities
    isTrustedSeed: isTrustedNetworkSeed,

    // Simulation
    simulationConfig,
    setSimulationConfig,
  }

  return (
    <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>
  )
}

export const useNetworkIfAvailable = () => useContext(NetworkContext)
export const useNetwork = () => {
  const context = useNetworkIfAvailable()
  if (!context) {
    throw new Error('useNetwork must be used within a NetworkProvider')
  }
  return context
}
