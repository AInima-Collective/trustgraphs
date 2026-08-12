'use client'

import { CheckCircle2, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import {
  type Address,
  Hex,
  decodeEventLog,
  parseEther,
  zeroAddress,
} from 'viem'
import { usePublicClient, useSimulateContract } from 'wagmi'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { useEnsResolver } from '@/hooks/useEns'
import {
  governedTrustgraphsFactoryAbi,
  trustgraphsFactoryAbi,
} from '@/lib/contract-abis'
import {
  EnsResolutionChangedError,
  getAccountIdentifierErrorMessage,
} from '@/lib/ens-query'
import { txToast } from '@/lib/tx'

import {
  CreateArgs,
  FACTORY_ADDRESS,
  GOVERNED_FACTORY_ADDRESS,
  WizardData,
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

  // Simulation runs the same validation before the wallet asks for a signature.
  const {
    error: preflightError,
    isLoading: preflighting,
    isSuccess: preflightPassed,
  } = useSimulateContract({
    address: GOVERNED_FACTORY_ADDRESS,
    abi: governedTrustgraphsFactoryAbi,
    functionName: 'createGovernedInstance',
    args: [args] as any,
    ...(prepay > 0n ? { value: prepay } : {}),
    query: { enabled: !!GOVERNED_FACTORY_ADDRESS && !!args.name },
  })

  const effective = effectiveBlocks(data.tuning.cadence, epochFloor)

  const create = async () => {
    setFailure(null)
    setCreating(true)
    try {
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
          args: [args] as any,
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
          args: [args],
          ...(gas ? { gas } : {}),
          ...(prepay > 0n ? { value: prepay } : {}),
        } as any,
        successMessage: 'Your network is live!',
      })

      let createdEvent: Record<string, unknown> | undefined
      let governedEvent: Record<string, unknown> | undefined
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
            }
          }
        } catch {
          // Not one of ours.
        }
      }

      if (createdEvent && governedEvent) {
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
        lead="One transaction creates the vouch registry, scoreboard, DAO Safe, and voting module. The Safe owns every network authority from the first block."
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
        <SummaryRow label="Shared fund">{fundSummary}</SummaryRow>
        <SummaryRow label="In charge afterwards">
          DAO Safe with Merkle voting; your connected wallet is its initial
          signer.
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
      </div>

      {preflighting && (
        <div className="flex flex-row items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Checking your settings against the network...
        </div>
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
          disabled={creating || !!preflightError}
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
