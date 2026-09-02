'use client'

import { CheckCircle2, LoaderCircle } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import {
  type Address,
  Hex,
  decodeEventLog,
  encodeFunctionData,
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
import { useAuthorityProfile } from '@/hooks/useAuthorityProfile'
import { useEnsResolver } from '@/hooks/useEns'
import { PROVING_VAULT, SUBNETWORK_CONFIG } from '@/lib/config'
import {
  governedTrustgraphsFactoryAbi,
  trustgraphsFactoryAbi,
} from '@/lib/contract-abis'
import {
  EnsResolutionChangedError,
  getAccountIdentifierErrorMessage,
} from '@/lib/ens-query'
import {
  ETHEREUM_TRANSACTION_GAS_CAP,
  bufferedEthereumGasLimit,
} from '@/lib/ethereum-gas'
import { saveGovernancePrefill } from '@/lib/governance-prefill'
import {
  conservativeRefreshEstimate,
  initialPolicyForCreation,
} from '@/lib/proving-prepay'
import { priceFeedReadAbi, provingVaultReadAbi } from '@/lib/settings-contracts'
import { governedSubnetworkFactoryAbi } from '@/lib/subnetwork'
import { txToast } from '@/lib/tx'

import {
  CreateArgs,
  FACTORY_ADDRESS,
  GOVERNED_FACTORY_ADDRESS,
  WizardData,
  type WizardStepId,
  buildOffchainEasConfig,
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
  offchainRegistry: Hex
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
  parentInstanceId,
  parentNetworkId,
}: {
  data: WizardData
  args: CreateArgs
  epochFloor: bigint
  metadataUri: string
  onCreated: (created: CreatedNetwork) => void
  onJumpTo: (step: WizardStepId) => void
  onSeedsChanged: (seeds: Hex[], seedNames: Record<string, string>) => void
  parentInstanceId?: Hex
  parentNetworkId?: string
}) => {
  const router = useRouter()
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
  const offchain = buildOffchainEasConfig(data)
  const authorityFactoryAddress = ((parentInstanceId
    ? SUBNETWORK_CONFIG?.governedFactory
    : GOVERNED_FACTORY_ADDRESS) || '') as Hex
  const createFunction = data.withOffchainVouches
    ? 'createGovernedHybridInstance'
    : 'createGovernedInstance'
  const createFunctionArgs = data.withOffchainVouches
    ? [args, offchain, initialPolicy, signerSync]
    : [args, initialPolicy, signerSync]

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

  // The live governance profile, via the shared hook (all three governed wrappers expose the
  // identical read surface, so the weighted and composition workspaces run this same check).
  const {
    loading: authorityLoading,
    memberVotingDelay,
    memberVotingPeriod,
    memberExecutionDelay,
    recoveryDelay,
    valid: authorityProfileValid,
  } = useAuthorityProfile(authorityFactoryAddress)

  // Simulation runs the same validation before the wallet asks for a signature.
  const {
    error: preflightError,
    isLoading: preflighting,
    isSuccess: preflightPassed,
  } = useSimulateContract({
    address: GOVERNED_FACTORY_ADDRESS,
    abi: governedTrustgraphsFactoryAbi,
    functionName: createFunction,
    args: createFunctionArgs as any,
    gas: ETHEREUM_TRANSACTION_GAS_CAP,
    ...(prepay > 0n ? { value: prepay } : {}),
    query: {
      enabled:
        !parentInstanceId &&
        !!GOVERNED_FACTORY_ADDRESS &&
        !!args.name &&
        authorityProfileValid,
    },
  })

  const create = async () => {
    setFailure(null)
    setCreating(true)
    try {
      if (parentInstanceId) {
        if (!authorityProfileValid || authorityFactoryAddress.length !== 42) {
          setFailure(
            'Creation is disabled because the governed factory authority profile could not be verified.'
          )
          return
        }
        const tiers = { admin: 0, guardian: 1, label: 2 } as const
        const dataHex = encodeFunctionData({
          abi: governedSubnetworkFactoryAbi,
          functionName: 'createGovernedSubnetwork',
          args: [
            args,
            initialPolicy,
            signerSync,
            parentInstanceId,
            tiers[data.subnetworkTier],
          ],
        })
        const fingerprint = keccak256(dataHex)
        saveGovernancePrefill({
          version: 2,
          networkId: parentNetworkId ?? parentInstanceId,
          fingerprint,
          title: `Create ${args.name} as a sub-network`,
          description: `Create ${args.name}, register it beneath this network, and install the ${data.subnetworkTier} parent-authority tier atomically.`,
          actions: [
            {
              actionKey: 'custom',
              values: {
                target: authorityFactoryAddress,
                valueEth: data.prepayEth.trim() || '0',
                data: dataHex,
                operation: 0,
                description: `Create ${args.name} as a ${data.subnetworkTier}-tier sub-network`,
              },
            },
          ],
          createdAt: Date.now(),
        })
        router.push(
          `/networks/${parentNetworkId ?? parentInstanceId}/governance?new=1&actionDraft=${fingerprint}`
        )
        return
      }
      if (!preflightPassed) {
        setFailure('Wait for the network preflight to pass before creating.')
        return
      }
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

      // Sepolia enforces EIP-7825's 2^24 per-transaction gas cap. The capped preflight above
      // proves the call fits; keep a provider-independent margin without submitting an invalid
      // gas limit when an RPC has already padded its estimate.
      let gas = ETHEREUM_TRANSACTION_GAS_CAP
      try {
        const estimate = await publicClient?.estimateContractGas({
          address: GOVERNED_FACTORY_ADDRESS,
          abi: governedTrustgraphsFactoryAbi,
          functionName: createFunction,
          args: createFunctionArgs as any,
          ...(prepay > 0n ? { value: prepay } : {}),
        })
        gas = estimate ? bufferedEthereumGasLimit(estimate) : gas
      } catch {
        // The capped preflight already proved that using the protocol maximum is sufficient.
      }

      const [receipt] = await txToast({
        tx: {
          address: GOVERNED_FACTORY_ADDRESS,
          abi: governedTrustgraphsFactoryAbi,
          functionName: createFunction,
          args: createFunctionArgs,
          gas,
          ...(prepay > 0n ? { value: prepay } : {}),
        } as any,
        successMessage: 'Your network is live!',
      })

      let createdEvent: Record<string, unknown> | undefined
      let governedEvent: Record<string, unknown> | undefined
      let authorityEvent: Record<string, unknown> | undefined
      let offchainEvent: Record<string, unknown> | undefined
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
            } else if (decoded.eventName === 'OffchainEasLaneCreated') {
              offchainEvent = decoded.args as Record<string, unknown>
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
          offchainRegistry:
            (offchainEvent?.registry as Hex | undefined) ?? zeroAddress,
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
    ? 'Not added'
    : data.fundToken === 'eth'
      ? 'Added, with ETH as the default payout asset'
      : `Added, with ${shortAddress(data.fundTokenAddress.trim())} as the default payout asset`

  return (
    <div className="space-y-6">
      <StepHeader
        title="Review and create"
        lead={
          parentInstanceId
            ? 'Check the child and its authority tier, then prepare the exact action for the parent governance proposal.'
            : 'Check the network, scoring, and governance settings below. One wallet transaction creates everything.'
        }
      />

      <Card type="outline" size="md">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
          <h3 className="text-sm font-medium">Network</h3>
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onJumpTo('description')}
            >
              Edit details
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onJumpTo('accounts')}
            >
              Edit accounts
            </Button>
          </div>
        </div>
        <SummaryRow label="Name">{args.name}</SummaryRow>
        <SummaryRow label="Purpose">
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
        <SummaryRow label="Description storage">
          {metadataUri ? (
            <span className="font-mono text-xs break-all">{metadataUri}</span>
          ) : (
            <span className="text-muted-foreground">
              Not saved. The network will show its name only.
            </span>
          )}
        </SummaryRow>
      </Card>

      <Card type="outline" size="md">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
          <h3 className="text-sm font-medium">Scoring and publication</h3>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onJumpTo('scoring')}
          >
            Edit scoring
          </Button>
        </div>
        <SummaryRow label="Score schedule">
          {describeBlocks(effective)}
        </SummaryRow>
        <SummaryRow label="Vouch influence">
          {data.tuning.vouchWeightPct}%
        </SummaryRow>
        <SummaryRow label="Starting-account share">
          {data.tuning.headStartPct}%
        </SummaryRow>
        <SummaryRow label="Weight kept per step">
          {data.tuning.headStartKeptPct}%
        </SummaryRow>
        <SummaryRow label="Total score points">
          {data.tuning.totalPoints.toLocaleString()}
        </SummaryRow>
        <SummaryRow label="Proof funding">
          {prepay > 0n
            ? `${data.prepayEth.trim()} ETH prepaid for score refreshes`
            : 'No prepayment. Anyone may produce and publish a valid proof.'}
        </SummaryRow>
        {prepay > 0n && (
          <>
            <SummaryRow label="Maximum per refresh">
              ${formatUnits(initialPolicy.maxPerRootUsd, 8)} USD for the proof
              and gas
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
                ? 'Waiting for the ETH/USD price feed'
                : refreshEstimate === 0n
                  ? 'Less than one at the current price and maximum payment'
                  : `At least ${refreshEstimate.toLocaleString()} at the current price if every refresh uses the maximum payment`}
            </SummaryRow>
            <SummaryRow label="Unused prepayment">
              Governance can withdraw it after{' '}
              {withdrawalNotice > 0n
                ? `${Number(withdrawalNotice) / 86_400} days`
                : 'the vault’s configured notice period'}
              .
            </SummaryRow>
          </>
        )}
      </Card>

      <Card type="outline" size="md">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
          <h3 className="text-sm font-medium">Governance and extras</h3>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onJumpTo('extras')}
          >
            Edit extras
          </Button>
        </div>
        <SummaryRow label="Governance">
          Included. Members control the network through delayed, trust-weighted
          voting.
        </SummaryRow>
        {parentInstanceId && (
          <SummaryRow label="Parent authority">
            {data.subnetworkTier === 'admin'
              ? 'Admin — the parent can operate this Safe immediately.'
              : data.subnetworkTier === 'guardian'
                ? 'Guardian — the parent can queue recovery actions behind 14 days of notice.'
                : 'Label only — the relationship grants no parent power.'}
          </SummaryRow>
        )}
        <SummaryRow label="Voting timeline">
          {authorityProfileValid
            ? `${describeBlocks(memberVotingDelay ?? 0n)} before voting, ${describeBlocks(memberVotingPeriod ?? 0n)} to vote, then ${describeBlocks(memberExecutionDelay ?? 0n)} before execution.`
            : 'Unavailable — creation is disabled.'}
        </SummaryRow>
        <SummaryRow label={parentInstanceId ? 'Recovery route' : 'Your wallet'}>
          {parentInstanceId ? (
            data.subnetworkTier === 'label' ? (
              'Held by the child Safe itself; the parent receives no recovery power.'
            ) : (
              `The parent is recovery proposer with a ${Number(recoveryDelay ?? 0n) / 86_400}-day delay.`
            )
          ) : (
            <>
              Recovery proposer with a{' '}
              {authorityProfileValid
                ? `${Number(recoveryDelay) / 86_400}-day delay`
                : 'recovery delay that could not be read'}
              ; not an immediate administrator.
            </>
          )}
        </SummaryRow>
        <SummaryRow label="Shared fund">{fundSummary}</SummaryRow>
        <SummaryRow label="Vouches">
          {data.withOffchainVouches
            ? 'On-chain EAS plus gasless off-chain vouches'
            : 'On-chain EAS. Gasless off-chain vouches are coming soon.'}
        </SummaryRow>
        <SummaryRow label="Score-selected Safe signers">
          {data.withSignerSync
            ? `Top ${data.signerTopN}, ${data.signerTargetThresholdPct}% target threshold, minimum ${data.signerMinThreshold}`
            : 'Not added'}
        </SummaryRow>
        <SummaryRow label="Safe execution">
          Owner-signed transactions are disabled. Passed governance proposals
          execute through the Safe after their delay.
        </SummaryRow>
      </Card>

      {!parentInstanceId && preflighting && (
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

      {!parentInstanceId && preflightError && (
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

      {!parentInstanceId && preflightPassed && !preflightError && (
        <div className="flex flex-row items-center gap-2 text-sm">
          <CheckCircle2 className="h-4 w-4" />
          Everything checks out. Signing will create the network.
        </div>
      )}

      {parentInstanceId && authorityProfileValid && (
        <div className="flex flex-row items-center gap-2 text-sm">
          <CheckCircle2 className="h-4 w-4" />
          Everything checks out. Continue to review the parent governance
          proposal.
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
          disabled={
            creating ||
            (!parentInstanceId &&
              (preflighting || !preflightPassed || !!preflightError)) ||
            !authorityProfileValid
          }
        >
          {creating && <LoaderCircle className="h-4 w-4 animate-spin" />}
          {creating
            ? parentInstanceId
              ? 'Preparing proposal...'
              : 'Creating your network...'
            : parentInstanceId
              ? 'Prepare parent proposal'
              : 'Create network'}
        </Button>
        <Note>
          {parentInstanceId
            ? 'Nothing is sent yet. The parent network must pass the prepared proposal before the child is created.'
            : 'You pay the transaction fee for this and nothing else. There is no charge for creating a network.'}
        </Note>
      </div>
    </div>
  )
}
