'use client'

import { CheckCircle2, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import {
  type Address,
  Hex,
  decodeEventLog,
  formatUnits,
  keccak256,
  parseEther,
  toBytes,
  zeroAddress,
} from 'viem'
import {
  usePublicClient,
  useReadContract,
  useReadContracts,
  useSimulateContract,
} from 'wagmi'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { useEnsResolver } from '@/hooks/useEns'
import { PROVING_VAULT } from '@/lib/config'
import {
  governedTrustgraphsFactoryAbi,
  trustgraphsFactoryAbi,
} from '@/lib/contract-abis'
import {
  EnsResolutionChangedError,
  getAccountIdentifierErrorMessage,
} from '@/lib/ens-query'
import {
  conservativeRefreshEstimate,
  initialPolicyForCreation,
} from '@/lib/proving-prepay'
import { priceFeedReadAbi, provingVaultReadAbi } from '@/lib/settings-contracts'
import {
  hasUnreservedTrustShare,
  unreservedTrustSharePct,
} from '@/lib/trust-share'
import { txToast } from '@/lib/tx'

import {
  CreateArgs,
  FACTORY_ADDRESS,
  GOVERNED_FACTORY_ADDRESS,
  WizardData,
  buildSignerSyncConfig,
  describeBlocks,
  effectiveBlocks,
  explainFactoryError,
} from '../model'
import { Note, StepHeader, SummaryRow } from '../ui'

export type CreatedNetwork = {
  instanceId: Hex
  snapshot: Hex
  resolver: Hex
  distributor: Hex
  epochBlocks: bigint
  name: string
  safe: Hex
  merkleGovModule: Hex
  executionGuard: Hex
  recoveryModule: Hex
  recoveryDelay: bigint
  signerSyncModule: Hex
}

const shortAddress = (address: string) =>
  `${address.slice(0, 8)}...${address.slice(-6)}`

export const ReviewStep = ({
  data,
  args,
  epochFloor,
  metadataUri,
  onCreated,
  onJumpTo,
  onSeedsChanged,
}: {
  data: WizardData
  args: CreateArgs
  epochFloor: bigint
  metadataUri: string
  onCreated: (created: CreatedNetwork) => void
  onJumpTo: (step: number) => void
  onSeedsChanged: (seeds: Hex[], seedNames: Record<string, string>) => void
}) => {
  const publicClient = usePublicClient()
  const [creating, setCreating] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const resolveAccountIdentifier = useEnsResolver()

  // The optional prepay rides along as `msg.value`; the governed wrapper forwards it through the
  // Safe and into the new instance's proving tank. Blank means none, which is the default.
  const prepay = data.prepayEth.trim() ? parseEther(data.prepayEth.trim()) : 0n
  const effective = effectiveBlocks(data.tuning.cadence, epochFloor)
  const initialPolicy = initialPolicyForCreation(
    prepay,
    effective,
    data.maxPerRootUsd
  )
  const signerSync = buildSignerSyncConfig(data)

  const program = keccak256(toBytes('trust-graph'))
  const { data: vaultPreview } = useReadContracts({
    contracts:
      prepay > 0n && PROVING_VAULT
        ? [
            {
              address: PROVING_VAULT,
              abi: provingVaultReadAbi,
              functionName: 'feePerRootUsd',
              args: [program, 1],
            },
            {
              address: PROVING_VAULT,
              abi: provingVaultReadAbi,
              functionName: 'withdrawalNotice',
            },
            {
              address: PROVING_VAULT,
              abi: provingVaultReadAbi,
              functionName: 'ETH_USD_FEED',
            },
          ]
        : [],
    query: { enabled: prepay > 0n && !!PROVING_VAULT },
  })
  const initialBandFee = (vaultPreview?.[0]?.result as bigint | undefined) ?? 0n
  const withdrawalNotice =
    (vaultPreview?.[1]?.result as bigint | undefined) ?? 0n
  const priceFeed = vaultPreview?.[2]?.result as Address | undefined
  const { data: priceRound } = useReadContract({
    address: priceFeed ?? zeroAddress,
    abi: priceFeedReadAbi,
    functionName: 'latestRoundData',
    query: { enabled: prepay > 0n && !!priceFeed },
  })
  const ethUsd = priceRound?.[1] && priceRound[1] > 0n ? priceRound[1] : 0n
  const refreshEstimate = conservativeRefreshEstimate(
    prepay,
    ethUsd,
    initialPolicy.maxPerRootUsd
  )

  const { data: authorityPreview, isLoading: authorityLoading } =
    useReadContracts({
      contracts: GOVERNED_FACTORY_ADDRESS
        ? [
            {
              address: GOVERNED_FACTORY_ADDRESS,
              abi: governedTrustgraphsFactoryAbi,
              functionName: 'MEMBER_VOTING_DELAY',
            },
            {
              address: GOVERNED_FACTORY_ADDRESS,
              abi: governedTrustgraphsFactoryAbi,
              functionName: 'MEMBER_VOTING_PERIOD',
            },
            {
              address: GOVERNED_FACTORY_ADDRESS,
              abi: governedTrustgraphsFactoryAbi,
              functionName: 'MEMBER_EXECUTION_DELAY',
            },
            {
              address: GOVERNED_FACTORY_ADDRESS,
              abi: governedTrustgraphsFactoryAbi,
              functionName: 'RECOVERY_DELAY',
            },
          ]
        : [],
      query: { enabled: !!GOVERNED_FACTORY_ADDRESS },
    })
  const memberVotingDelay = authorityPreview?.[0]?.result as bigint | undefined
  const memberVotingPeriod = authorityPreview?.[1]?.result as bigint | undefined
  const memberExecutionDelay = authorityPreview?.[2]?.result as
    | bigint
    | undefined
  const recoveryDelay = authorityPreview?.[3]?.result as bigint | undefined
  const authorityProfileValid =
    authorityPreview?.length === 4 &&
    authorityPreview.every((read) => read.status === 'success') &&
    memberVotingDelay !== undefined &&
    memberVotingDelay > 0n &&
    memberVotingPeriod !== undefined &&
    memberVotingPeriod > 0n &&
    memberExecutionDelay !== undefined &&
    memberExecutionDelay > 0n &&
    recoveryDelay !== undefined &&
    recoveryDelay >= 14n * 86_400n

  // Simulation runs the same validation before the wallet asks for a signature.
  const {
    error: preflightError,
    isLoading: preflighting,
    isSuccess: preflightPassed,
  } = useSimulateContract({
    address: GOVERNED_FACTORY_ADDRESS,
    abi: governedTrustgraphsFactoryAbi,
    functionName: 'createGovernedInstance',
    args: [args, initialPolicy, signerSync] as any,
    ...(prepay > 0n ? { value: prepay } : {}),
    query: {
      enabled:
        !!GOVERNED_FACTORY_ADDRESS && !!args.name && authorityProfileValid,
    },
  })

  const create = async () => {
    setFailure(null)
    setCreating(true)
    try {
      if (!authorityProfileValid) {
        setFailure(
          'Creation is disabled because the configured governed factory does not expose the sealed authority profile. Redeploy or select the current factory before creating a network.'
        )
        return
      }
      for (const [preview, name] of Object.entries(data.seedNames)) {
        if (!data.seeds.some((seed) => seed.toLowerCase() === preview)) continue

        try {
          await resolveAccountIdentifier(name, preview as Address)
        } catch (error) {
          if (error instanceof EnsResolutionChangedError) {
            const nextAddress = error.currentAddress
            const nextSeeds = data.seeds.map((seed) =>
              seed.toLowerCase() === preview ? nextAddress : seed
            )
            if (
              nextSeeds.some(
                (seed, index) =>
                  nextSeeds.findIndex(
                    (candidate) =>
                      candidate.toLowerCase() === seed.toLowerCase()
                  ) !== index
              )
            ) {
              setFailure(
                `${name} changed to an account already on the list. Edit the starting accounts before continuing.`
              )
              return
            }
            const nextNames = { ...data.seedNames }
            delete nextNames[preview]
            nextNames[nextAddress.toLowerCase()] = name
            onSeedsChanged(nextSeeds, nextNames)
            setFailure(error.message)
            return
          }
          setFailure(getAccountIdentifierErrorMessage(error))
          return
        }
      }

      let gas: bigint | undefined
      try {
        const estimate = await publicClient?.estimateContractGas({
          address: GOVERNED_FACTORY_ADDRESS,
          abi: governedTrustgraphsFactoryAbi,
          functionName: 'createGovernedInstance',
          args: [args, initialPolicy, signerSync] as any,
          ...(prepay > 0n ? { value: prepay } : {}),
        })
        gas = estimate ? (estimate * 125n) / 100n : undefined
      } catch {
        // Fall back to the wallet's own estimate.
      }

      const [receipt] = await txToast({
        tx: {
          address: GOVERNED_FACTORY_ADDRESS,
          abi: governedTrustgraphsFactoryAbi,
          functionName: 'createGovernedInstance',
          args: [args, initialPolicy, signerSync],
          ...(gas ? { gas } : {}),
          ...(prepay > 0n ? { value: prepay } : {}),
        } as any,
        successMessage: 'Your network is live!',
      })

      let createdEvent: Record<string, unknown> | undefined
      let governedEvent: Record<string, unknown> | undefined
      let authorityEvent: Record<string, unknown> | undefined
      for (const log of receipt.logs) {
        try {
          if (log.address.toLowerCase() === FACTORY_ADDRESS.toLowerCase()) {
            const decoded = decodeEventLog({
              abi: trustgraphsFactoryAbi,
              data: log.data,
              topics: log.topics,
            })
            if (decoded.eventName === 'InstanceCreated') {
              createdEvent = decoded.args as Record<string, unknown>
            }
          } else if (
            log.address.toLowerCase() === GOVERNED_FACTORY_ADDRESS.toLowerCase()
          ) {
            const decoded = decodeEventLog({
              abi: governedTrustgraphsFactoryAbi,
              data: log.data,
              topics: log.topics,
            })
            if (decoded.eventName === 'GovernedInstanceCreated') {
              governedEvent = decoded.args as Record<string, unknown>
            } else if (decoded.eventName === 'GovernedAuthorityInstalled') {
              authorityEvent = decoded.args as Record<string, unknown>
            }
          }
        } catch {
          // Not one of ours.
        }
      }

      if (createdEvent && governedEvent && authorityEvent) {
        onCreated({
          instanceId: createdEvent.instanceId as Hex,
          snapshot: createdEvent.snapshot as Hex,
          resolver: createdEvent.resolver as Hex,
          distributor: (createdEvent.distributor ?? zeroAddress) as Hex,
          epochBlocks:
            (createdEvent.epochLength as bigint | undefined) ?? effective,
          name: (createdEvent.name as string) || args.name,
          safe: governedEvent.safe as Hex,
          merkleGovModule: governedEvent.merkleGovModule as Hex,
          executionGuard: authorityEvent.executionGuard as Hex,
          recoveryModule: authorityEvent.recoveryModule as Hex,
          recoveryDelay:
            (authorityEvent.recoveryDelay as bigint | undefined) ?? 0n,
          signerSyncModule:
            (authorityEvent.signerSyncModule as Hex | undefined) ?? zeroAddress,
        })
        return
      }

      setFailure(
        'The transaction went through, but this app could not read the new network out of it. Check your wallet history, the network was probably created.'
      )
    } catch (error) {
      setFailure(explainFactoryError(error))
    } finally {
      setCreating(false)
    }
  }

  const fundSummary = !data.withFund
    ? 'No'
    : data.fundToken === 'eth'
      ? 'Yes, set up to pay out ETH'
      : `Yes, set up to pay out the token at ${shortAddress(data.fundTokenAddress.trim())}`

  return (
    <div className="space-y-6">
      <StepHeader
        title="Check it over, then sign once"
        lead="One transaction creates the vouch registry, scoreboard, DAO Safe, voting, and delayed recovery. The Safe graduates to module-only execution before the transaction returns."
      />

      <Card type="outline" size="md">
        <SummaryRow label="Name">{args.name}</SummaryRow>
        <SummaryRow label="What it is for">
          {data.description.trim() || (
            <span className="text-muted-foreground">Left blank</span>
          )}
        </SummaryRow>
        <SummaryRow label="What a vouch means">
          {data.criteria.trim() ? (
            <span className="line-clamp-3 whitespace-pre-wrap">
              {data.criteria.trim()}
            </span>
          ) : (
            <span className="text-muted-foreground">Left blank</span>
          )}
        </SummaryRow>
        <SummaryRow label="Starting accounts">
          <div className="space-y-1">
            {data.seeds.map((seed) => (
              <div key={seed} className="font-mono text-xs">
                {data.seedNames[seed.toLowerCase()]
                  ? `${data.seedNames[seed.toLowerCase()]} (${seed})`
                  : seed}
              </div>
            ))}
          </div>
        </SummaryRow>
        <SummaryRow label="Scores published">
          {describeBlocks(effective)}
        </SummaryRow>
        <SummaryRow label="Starting-account share">
          {data.tuning.headStartPct}%
        </SummaryRow>
        <SummaryRow label="Shared fund">{fundSummary}</SummaryRow>
        <SummaryRow label="Score-selected Safe signers">
          {data.withSignerSync
            ? `Yes — top ${data.signerTopN}, ${data.signerTargetThresholdPct}% target threshold, minimum ${data.signerMinThreshold}`
            : 'No'}
        </SummaryRow>
        <SummaryRow label="Refresh prepayment">
          {prepay > 0n
            ? `${data.prepayEth.trim()} ETH`
            : 'None — unpaid/curated policy'}
        </SummaryRow>
        {prepay > 0n && (
          <>
            <SummaryRow label="Paid refresh cadence">
              {describeBlocks(initialPolicy.minPaidIntervalBlocks)}
            </SummaryRow>
            <SummaryRow label="Maximum per refresh">
              ${formatUnits(initialPolicy.maxPerRootUsd, 8)} USD, including the
              proving fee and gas reimbursement
            </SummaryRow>
            <SummaryRow label="Initial fee band">
              {initialBandFee > 0n ? (
                `$${formatUnits(initialBandFee, 8)} per root while the graph has at most 1,000 inputs`
              ) : (
                <span className="text-destructive">
                  Not priced on this deployment. Creation will be blocked until
                  the global fee schedule is configured.
                </span>
              )}
            </SummaryRow>
            <SummaryRow label="Estimated refreshes">
              {refreshEstimate === null
                ? 'Waiting for the deployment’s ETH/USD feed'
                : refreshEstimate === 0n
                  ? 'Less than one at the current ETH price and full per-refresh cap'
                  : `At least ${refreshEstimate.toLocaleString()} at the current ETH price if every refresh spends the full cap`}
            </SummaryRow>
            <SummaryRow label="Unused prepayment">
              The DAO Safe may request a withdrawal, then execute it after{' '}
              {withdrawalNotice > 0n
                ? `${Number(withdrawalNotice) / 86_400} days`
                : 'the vault’s configured notice period'}
              . The app does not bypass that delay.
            </SummaryRow>
          </>
        )}
        <SummaryRow label="In charge afterwards">
          Members through delayed Merkle voting. Your connected wallet is the
          visible recovery proposer, not an immediate administrator.
        </SummaryRow>
        <SummaryRow label="Graduation">
          Atomic at creation. A permanently sealed guard disables every
          owner-signed Safe transaction, including settings, withdrawals,
          upgrades, delegatecalls, and batches.
        </SummaryRow>
        <SummaryRow label="Safe owners and threshold">
          Your connected wallet starts as the only recorded owner (1 of 1), but
          the owner execution route is disabled. Owners cannot remove the guard
          or add a bypass module directly.
        </SummaryRow>
        <SummaryRow label="Member governance delay">
          {authorityProfileValid
            ? `${describeBlocks(memberVotingDelay)} before voting, then ${describeBlocks(memberVotingPeriod)} to vote and ${describeBlocks(memberExecutionDelay)} before execution.`
            : 'Unavailable — creation is disabled.'}
        </SummaryRow>
        <SummaryRow label="Recovery delay">
          {authorityProfileValid
            ? `${Number(recoveryDelay) / 86_400} days. Your wallet may publish one exact Safe action, but cannot execute it early; anyone may execute after the deadline and the member-governed Safe may cancel or rotate the proposer.`
            : 'Unavailable — creation is disabled.'}
        </SummaryRow>
        <SummaryRow label="Description saved at">
          {metadataUri ? (
            <span className="font-mono text-xs break-all">{metadataUri}</span>
          ) : (
            <span className="text-muted-foreground">
              Not saved. Your network will show its name only.
            </span>
          )}
        </SummaryRow>
      </Card>

      {hasUnreservedTrustShare(data.tuning.headStartPct) && (
        <Note tone="warning">
          The remaining {unreservedTrustSharePct(data.tuning.headStartPct)}% is
          shared among every other account before vouches are applied. A
          disconnected group can gain scoreboard share by adding accounts.
        </Note>
      )}

      <div className="flex flex-row flex-wrap gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onJumpTo(0)}
        >
          Edit the description
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onJumpTo(1)}
        >
          Edit the starting accounts
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onJumpTo(2)}
        >
          Edit scoring
        </Button>
      </div>

      {preflighting && (
        <div className="flex flex-row items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Checking your settings against the network...
        </div>
      )}

      {!authorityLoading && !authorityProfileValid && (
        <Card type="outline" size="md" className="border-destructive space-y-2">
          <div className="text-sm text-destructive">
            The configured governed factory does not expose the required sealed
            guard, member-delay, and 14-day recovery profile. Creation is
            disabled so this app cannot create or market an ungraduated 1-of-1
            network.
          </div>
        </Card>
      )}

      {preflightError && (
        <Card type="outline" size="md" className="border-destructive space-y-2">
          <div className="text-sm text-destructive">
            {explainFactoryError(preflightError)}
          </div>
          <Note>
            Nothing has been sent yet. Go back and fix this, and we will check
            again.
          </Note>
        </Card>
      )}

      {preflightPassed && !preflightError && (
        <div className="flex flex-row items-center gap-2 text-sm">
          <CheckCircle2 className="h-4 w-4" />
          Everything checks out. Signing will create the network.
        </div>
      )}

      {failure && (
        <Card type="outline" size="md" className="border-destructive">
          <div className="text-sm text-destructive">{failure}</div>
        </Card>
      )}

      <div className="space-y-3">
        <Button
          type="button"
          onClick={create}
          disabled={creating || !!preflightError || !authorityProfileValid}
        >
          {creating && <LoaderCircle className="h-4 w-4 animate-spin" />}
          {creating ? 'Creating your network...' : 'Create network'}
        </Button>
        <Note>
          You pay the transaction fee for this and nothing else. There is no
          charge for creating a network.
        </Note>
      </div>
    </div>
  )
}
