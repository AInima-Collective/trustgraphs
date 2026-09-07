'use client'

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import {
  type Address,
  type Hex,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  stringToBytes,
  zeroAddress,
} from 'viem'
import { useBalance, usePublicClient, useReadContracts } from 'wagmi'

import { useNetwork } from '@/contexts/NetworkContext'
import { useTokenMetadata } from '@/hooks/useTokenMetadata'
import {
  type GovernanceActionContext,
  type GovernanceActionDraft,
  type GovernanceCurrentKey,
  type GovernanceFieldPicker,
  type TokenDisplay,
  formatRelativeSeconds,
  governanceActionContextFor,
  governanceActionFields,
  governanceContractLabels,
  shortenHex,
} from '@/lib/actions'
import { blockTimeSeconds, formatBlockEta } from '@/lib/blocks'
import type { InstanceRow } from '@/lib/catalog'
import { APIS } from '@/lib/config'
import {
  gnosisSafeAbi,
  merkleSnapshotAbi,
  signerSyncZkModuleAbi,
} from '@/lib/contract-abis'
import type { ExactParamsJson } from '@/lib/scoring-params'
import {
  delayedRecoveryModuleReadAbi,
  gnosisSafeAuthorityReadAbi,
  provingVaultReadAbi,
} from '@/lib/settings-contracts'
import type { Network } from '@/lib/types'
import { usePonderQuery } from '@/lib/use-ponder-query'
import { getTargetChainId } from '@/lib/wagmi'
import { ponderQueryFns } from '@/queries/ponder'

/** One choice a field can take instead of typing; `fill` sets sibling fields at the same time. */
export type GovernancePickerOption = {
  value: string
  label: string
  description?: string
  fill?: Record<string, unknown>
}

export type GovernanceComposerData = {
  actionContext: GovernanceActionContext
  network: Network
  blockTimeSeconds: number
  /** A name for one of this network's own contracts, by address. */
  contractLabel: (address: string | undefined) => string | undefined
  /** Live settings in the same representation the matching field stores. */
  current: Partial<Record<GovernanceCurrentKey, string>>
  pickers: Partial<Record<GovernanceFieldPicker, GovernancePickerOption[]>>
  /** Ordered Safe lists, for deriving linked-list predecessors. */
  safeOwners: readonly Address[]
  safeModules: readonly Address[]
  token: (address: string) => TokenDisplay | undefined
  tokenState: (address: string) => 'loading' | 'ready' | 'error' | 'stale'
  /** The treasury's balance of a token (zero address = ETH), when read. */
  treasuryBalance: (token: string) => bigint | undefined
  /** The parent network's exact live scoring tuple, for rounds and parameter edits. */
  parentParams?: { params: ExactParamsJson; epochLength: string }
  parentParamsState: 'idle' | 'loading' | 'ready' | 'error'
  /** Context lines for actions without arguments: what they would cancel. */
  pending: {
    weightedPrior?: string
    compositionPolicy?: string
    vaultWithdrawal?: string
  }
}

const OPERATIONAL_ROLE = keccak256(stringToBytes('OPERATIONAL_ROLE'))
const SAFE_SENTINEL = '0x0000000000000000000000000000000000000001' as Address
const SAFE_GUARD_STORAGE_SLOT =
  0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8n

type ReadResult = { status?: string; result?: unknown }

const asBigInt = (value: unknown): bigint | undefined =>
  typeof value === 'bigint' ? value : undefined
const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined
const asAddress = (value: unknown): Address | undefined =>
  typeof value === 'string' && isAddress(value) ? getAddress(value) : undefined
const asAddressList = (value: unknown): Address[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const address = asAddress(entry)
        return address ? [address] : []
      })
    : []
const tupleValue = (tuple: unknown, name: string, index: number): unknown => {
  if (Array.isArray(tuple)) return tuple[index]
  if (tuple && typeof tuple === 'object') {
    return (
      (tuple as Record<string, unknown>)[name] ?? Object.values(tuple)[index]
    )
  }
  return undefined
}
/** The Safe stores its guard as a 32-byte word: the address is the low 20 bytes. */
const storageAddress = (value: unknown): Address | undefined => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value))
    return undefined
  return asAddress(`0x${value.slice(-40)}`)
}

/**
 * Everything the composer's typed fields draw on beyond the draft itself: live settings, the
 * network's own contract names, Safe lists, token metadata and treasury balances, proven roots,
 * open proposals, role holders. Reads are batched and cached; a missing source degrades to a
 * field without a picker or a "currently" line, never to a broken editor.
 */
export function useGovernanceComposerData(
  drafts: readonly GovernanceActionDraft[]
): GovernanceComposerData {
  const { network } = useNetwork()
  const publicClient = usePublicClient()
  const chainId = getTargetChainId()
  const actionContext = useMemo(
    () => governanceActionContextFor(network),
    [network]
  )
  const {
    snapshot,
    signerSyncModule,
    treasurySafe,
    recoveryModule,
    provingVault,
    governanceModule,
    fundDistributor,
    instanceId,
  } = actionContext

  const contractLabels = useMemo(
    () => governanceContractLabels(network),
    [network]
  )

  // Live contract state that no indexer table carries, or that must not lag finality.
  const reads = useMemo(() => {
    const list: { key: string; contract: unknown }[] = []
    const push = (key: string, contract: unknown) =>
      list.push({ key, contract })
    if (snapshot) {
      for (const functionName of [
        'zkVerifier',
        'accumulator',
        'anchorRegistry',
      ] as const) {
        push(functionName, {
          chainId,
          address: snapshot,
          abi: merkleSnapshotAbi,
          functionName,
        })
      }
    }
    if (signerSyncModule) {
      push('signerPaused', {
        chainId,
        address: signerSyncModule,
        abi: signerSyncZkModuleAbi,
        functionName: 'paused',
      })
    }
    if (treasurySafe) {
      push('safeOwners', {
        chainId,
        address: treasurySafe,
        abi: gnosisSafeAbi,
        functionName: 'getOwners',
      })
      push('safeModules', {
        chainId,
        address: treasurySafe,
        abi: gnosisSafeAuthorityReadAbi,
        functionName: 'getModulesPaginated',
        args: [SAFE_SENTINEL, 50n],
      })
      push('safeGuard', {
        chainId,
        address: treasurySafe,
        abi: gnosisSafeAuthorityReadAbi,
        functionName: 'getStorageAt',
        args: [SAFE_GUARD_STORAGE_SLOT, 1n],
      })
    }
    if (recoveryModule) {
      push('recoveryProposer', {
        chainId,
        address: recoveryModule,
        abi: delayedRecoveryModuleReadAbi,
        functionName: 'proposer',
      })
    }
    if (provingVault && instanceId) {
      push('vaultPolicy', {
        chainId,
        address: provingVault,
        abi: provingVaultReadAbi,
        functionName: 'policyOf',
        args: [instanceId],
      })
      push('vaultPending', {
        chainId,
        address: provingVault,
        abi: provingVaultReadAbi,
        functionName: 'pendingWithdrawalOf',
        args: [instanceId],
      })
      push('vaultUsdc', {
        chainId,
        address: provingVault,
        abi: provingVaultReadAbi,
        functionName: 'USDC',
      })
    }
    return list
  }, [
    chainId,
    instanceId,
    provingVault,
    recoveryModule,
    signerSyncModule,
    snapshot,
    treasurySafe,
  ])
  const { data: readResults } = useReadContracts({
    contracts: reads.map((entry) => entry.contract) as any,
    query: { enabled: reads.length > 0, refetchInterval: 30_000 },
  })
  const read = (key: string): unknown => {
    const index = reads.findIndex((entry) => entry.key === key)
    const result = (readResults as readonly ReadResult[] | undefined)?.[index]
    return index >= 0 && result?.status === 'success'
      ? result.result
      : undefined
  }

  const { data: govModule } = usePonderQuery({
    queryFn: ponderQueryFns.getGovModule(governanceModule ?? zeroAddress),
    enabled: !!governanceModule,
  })
  const { data: distributor } = usePonderQuery({
    queryFn: ponderQueryFns.getFundDistributor(fundDistributor ?? zeroAddress),
    enabled: !!fundDistributor,
  })
  const { data: proposals } = usePonderQuery({
    queryFn: ponderQueryFns.getGovModuleProposals(
      governanceModule ?? zeroAddress,
      50
    ),
    enabled: !!governanceModule,
  })
  const { data: roleMembers } = usePonderQuery({
    queryFn: ponderQueryFns.getSnapshotRoleMembers(snapshot ?? zeroAddress),
    enabled: !!snapshot,
  })
  const { data: snapshots } = usePonderQuery({
    queryFn: ponderQueryFns.getMerkleSnapshots(snapshot ?? zeroAddress, 12),
    enabled: !!snapshot,
  })
  const { data: pendingWeighted } = usePonderQuery({
    queryFn: ponderQueryFns.getPendingWeightedPriorVersion(
      instanceId ?? `0x${'0'.repeat(64)}`
    ),
    enabled: !!instanceId && !!actionContext.weightedParamsController,
  })
  const { data: pendingComposition } = usePonderQuery({
    queryFn: ponderQueryFns.getPendingCompositionPolicyVersion(
      instanceId ?? `0x${'0'.repeat(64)}`
    ),
    enabled: !!instanceId && !!actionContext.compositionParamsController,
  })
  const { data: queuedRecovery } = usePonderQuery({
    queryFn: ponderQueryFns.getQueuedRecoveryActions(
      recoveryModule ?? zeroAddress
    ),
    enabled: !!recoveryModule,
  })
  const { data: currentBlock = 0n } = useQuery({
    queryKey: ['blockNumber'],
    queryFn: async () => (publicClient ? publicClient.getBlockNumber() : 0n),
    refetchInterval: 12_000,
    enabled: !!publicClient,
  })
  const parentQuery = useQuery({
    queryKey: ['instance-exact-params', instanceId?.toLowerCase()],
    queryFn: async () => {
      const response = await fetch(`${APIS.ponder}/instances/${instanceId}`)
      if (!response.ok) {
        throw new Error(
          `GET /instances/${instanceId} responded ${response.status}`
        )
      }
      const { instance } = (await response.json()) as { instance: InstanceRow }
      return instance
    },
    enabled: !!instanceId && !!APIS.ponder,
  })

  // Tokens named anywhere in the drafts, plus the ones this network already deals in.
  const vaultUsdc = asAddress(read('vaultUsdc'))
  const tokenAddresses = useMemo(() => {
    const set = new Set<string>([zeroAddress])
    if (vaultUsdc) set.add(vaultUsdc.toLowerCase())
    for (const draft of drafts) {
      const values =
        draft.values && typeof draft.values === 'object'
          ? (draft.values as Record<string, unknown>)
          : {}
      for (const field of governanceActionFields(draft.actionKey)) {
        if (field.picker !== 'token' && field.kind !== 'address') continue
        const value = values[field.key]
        if (typeof value === 'string' && isAddress(value))
          set.add(value.toLowerCase())
      }
    }
    return [...set]
  }, [drafts, vaultUsdc])
  const metadata = useTokenMetadata(tokenAddresses)
  const erc20s = tokenAddresses.filter((token) => token !== zeroAddress)
  const { data: balanceReads } = useReadContracts({
    contracts: erc20s.map((token) => ({
      chainId,
      address: token as Address,
      abi: erc20Abi,
      functionName: 'balanceOf' as const,
      args: [treasurySafe ?? zeroAddress],
    })),
    query: { enabled: !!treasurySafe && erc20s.length > 0 },
  })
  const { data: ethBalance } = useBalance({
    address: treasurySafe,
    chainId,
    query: { enabled: !!treasurySafe },
  })

  const safeOwners = asAddressList(read('safeOwners'))
  const safeModules = asAddressList(tupleValue(read('safeModules'), 'array', 0))
  const vaultPolicy = read('vaultPolicy')
  const vaultPending = read('vaultPending')

  return useMemo(() => {
    const contractLabel = (address: string | undefined) =>
      address ? contractLabels.get(address.toLowerCase()) : undefined
    const labelled = (address: Address): GovernancePickerOption => ({
      value: address,
      label: contractLabel(address) ?? shortenHex(address),
      description: contractLabel(address) ? shortenHex(address) : undefined,
    })

    const current: Partial<Record<GovernanceCurrentKey, string>> = {}
    if (govModule) {
      current.quorum = formatUnits(BigInt(govModule.quorum), 16)
      current.votingDelay = govModule.votingDelay.toString()
      current.votingPeriod = govModule.votingPeriod.toString()
    }
    if (distributor) {
      current.rewardsPaused = String(distributor.paused)
      current.rewardsFeeRecipient = getAddress(distributor.feeRecipient)
      try {
        current.rewardsFee = formatUnits(BigInt(distributor.feePercentage), 16)
      } catch {
        /* a non-integer numeric column stays unshown */
      }
      current.rewardsAllowlistEnabled = String(distributor.allowlistEnabled)
    }
    const signerPaused = asBoolean(read('signerPaused'))
    if (signerPaused !== undefined)
      current.signerSyncPaused = String(signerPaused)
    if (network.metadataURI) current.metadataURI = network.metadataURI
    const minInterval = asBigInt(
      tupleValue(vaultPolicy, 'minPaidIntervalBlocks', 0)
    )
    const maxPerRoot = asBigInt(tupleValue(vaultPolicy, 'maxPerRootUsd', 1))
    if (minInterval !== undefined)
      current.vaultMinPaidIntervalBlocks = minInterval.toString()
    if (maxPerRoot !== undefined)
      current.vaultMaxPerRootUsd = maxPerRoot.toString()
    const recoveryProposer = asAddress(read('recoveryProposer'))
    if (recoveryProposer) current.recoveryProposer = recoveryProposer
    const guard = storageAddress(read('safeGuard'))
    if (guard) current.safeGuard = guard
    const verifier = asAddress(read('zkVerifier'))
    if (verifier) current.snapshotVerifier = verifier
    const accumulator = asAddress(read('accumulator'))
    if (accumulator) current.snapshotAccumulator = accumulator
    const anchorRegistry = asAddress(read('anchorRegistry'))
    if (anchorRegistry) current.snapshotAnchorRegistry = anchorRegistry

    const pickers: Partial<
      Record<GovernanceFieldPicker, GovernancePickerOption[]>
    > = {}
    if (safeOwners.length) pickers['safe-owner'] = safeOwners.map(labelled)
    if (safeModules.length) pickers['safe-module'] = safeModules.map(labelled)
    pickers['network-contract'] = [...contractLabels.entries()].map(
      ([address, label]) => ({
        value: getAddress(address),
        label,
        description: shortenHex(getAddress(address)),
      })
    )
    const tokens: GovernancePickerOption[] = [
      { value: zeroAddress, label: 'ETH', description: 'Native ether' },
    ]
    if (vaultUsdc) {
      tokens.push({
        value: vaultUsdc,
        label: metadata.get(vaultUsdc)?.symbol ?? 'USDC',
        description: shortenHex(vaultUsdc),
      })
    }
    pickers.token = tokens
    if (proposals?.length) {
      pickers.proposal = proposals
        .filter((proposal) => !proposal.executed && !proposal.cancelled)
        .map((proposal) => ({
          value: proposal.id.toString(),
          label: `#${proposal.id} ${proposal.title}`.trim(),
          description:
            currentBlock > 0n
              ? proposal.endBlock > currentBlock
                ? `voting ends ${formatBlockEta(proposal.endBlock, currentBlock)}`
                : `voting ended ${formatBlockEta(proposal.endBlock, currentBlock)}`
              : undefined,
        }))
    }
    if (snapshots?.length) {
      pickers['score-root'] = snapshots.map((entry) => ({
        value: entry.root,
        label: shortenHex(entry.root),
        description: `total score ${entry.totalValue.toString()} · proven ${formatRelativeSeconds(Number(entry.timestamp))}`,
        fill: { expectedTotalMerkleValue: entry.totalValue.toString() },
      }))
    }
    if (roleMembers?.length) {
      const operational = roleMembers.filter(
        (member) => member.role.toLowerCase() === OPERATIONAL_ROLE.toLowerCase()
      )
      if (operational.length) {
        pickers['role-holder'] = operational.map((member) => ({
          value: getAddress(member.account),
          label: shortenHex(getAddress(member.account)),
          description: 'holds the operational role',
        }))
      }
    }
    if (queuedRecovery?.length) {
      pickers['recovery-action'] = queuedRecovery.map((entry) => ({
        value: entry.actionId,
        label: `#${entry.nonce.toString()} → ${contractLabel(entry.target) ?? shortenHex(getAddress(entry.target))}`,
        description: `${entry.safeOperation === 1 ? 'delegatecall' : 'call'} with ${formatUnits(entry.value, 18)} ETH, ready ${formatRelativeSeconds(Number(entry.readyAt))}`,
      }))
    }
    if (distributor?.allowlist?.length) {
      pickers['rewards-funder'] = distributor.allowlist.map((funder) => ({
        value: getAddress(funder),
        label: shortenHex(getAddress(funder)),
        description: 'currently allowed',
      }))
    }

    const balances = new Map<string, bigint>()
    if (ethBalance) balances.set(zeroAddress, ethBalance.value)
    erc20s.forEach((token, index) => {
      const result = (balanceReads as readonly ReadResult[] | undefined)?.[
        index
      ]
      const value = asBigInt(result?.status === 'success' ? result.result : 0)
      if (value !== undefined) balances.set(token, value)
    })

    const pending: GovernanceComposerData['pending'] = {}
    if (pendingWeighted) {
      pending.weightedPrior = `Version ${pendingWeighted.version.toString()} is pending${pendingWeighted.readyAt ? `, activatable ${formatRelativeSeconds(Number(pendingWeighted.readyAt))}` : ''}.`
    }
    if (pendingComposition) {
      pending.compositionPolicy = `Version ${pendingComposition.version.toString()} is pending${pendingComposition.readyAt ? `, activatable ${formatRelativeSeconds(Number(pendingComposition.readyAt))}` : ''}.`
    }
    const pendingEth = asBigInt(tupleValue(vaultPending, 'ethAmount', 0))
    const pendingUsdc = asBigInt(tupleValue(vaultPending, 'usdcAmount', 1))
    const readyAt = asBigInt(tupleValue(vaultPending, 'readyAt', 2))
    if (pendingEth !== undefined && pendingUsdc !== undefined) {
      pending.vaultWithdrawal =
        pendingEth === 0n && pendingUsdc === 0n
          ? 'No withdrawal is pending.'
          : `A withdrawal of ${formatUnits(pendingEth, 18)} ETH and ${formatUnits(pendingUsdc, 6)} USDC is pending${readyAt ? `, ready ${formatRelativeSeconds(Number(readyAt))}` : ''}.`
    }

    const parent = parentQuery.data
    return {
      actionContext,
      network,
      blockTimeSeconds: blockTimeSeconds(),
      contractLabel,
      current,
      pickers,
      safeOwners,
      safeModules,
      token: (address: string) =>
        isAddress(address) ? metadata.get(address) : undefined,
      tokenState: (address: string) =>
        isAddress(address) ? metadata.state(address) : 'error',
      treasuryBalance: (token: string) => balances.get(token.toLowerCase()),
      ...(parent?.params
        ? {
            parentParams: {
              params: parent.params as ExactParamsJson,
              epochLength: String(parent.epochLength),
            },
          }
        : {}),
      parentParamsState: !instanceId
        ? 'idle'
        : parentQuery.isError
          ? 'error'
          : parent?.params
            ? 'ready'
            : 'loading',
      pending,
    }
    // `read` is derived from `reads` + `readResults`, which are in this list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    actionContext,
    balanceReads,
    contractLabels,
    currentBlock,
    distributor,
    erc20s.join(','),
    ethBalance,
    govModule,
    metadata,
    network,
    parentQuery.data,
    parentQuery.isError,
    pendingComposition,
    pendingWeighted,
    proposals,
    queuedRecovery,
    readResults,
    reads,
    roleMembers,
    snapshots,
    instanceId,
    vaultUsdc,
  ])
}
