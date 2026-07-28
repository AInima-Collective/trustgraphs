'use client'

import { CheckCircle2, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import { Hex, decodeEventLog, parseEther, zeroAddress } from 'viem'
import { usePublicClient, useSimulateContract } from 'wagmi'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { trustGraphFactoryAbi } from '@/lib/contract-abis'
import { txToast } from '@/lib/tx'

import {
  CreateArgs,
  FACTORY_ADDRESS,
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
}: {
  data: WizardData
  args: CreateArgs
  epochFloor: bigint
  metadataUri: string
  onCreated: (created: CreatedNetwork) => void
  onJumpTo: (step: number) => void
}) => {
  const publicClient = usePublicClient()
  const [creating, setCreating] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // The factory runs the same checks as a view, so a bad setting shows up here rather than as a
  // The optional prepay rides along as `msg.value`; the factory forwards it into the new
  // instance's proving tank inside the same transaction. Blank means none, which is the default.
  const prepay = data.prepayEth.trim() ? parseEther(data.prepayEth.trim()) : 0n

  // failed signature.
  const {
    error: preflightError,
    isLoading: preflighting,
    isSuccess: preflightPassed,
  } = useSimulateContract({
    address: FACTORY_ADDRESS,
    abi: trustGraphFactoryAbi,
    functionName: 'createInstance',
    args: [args] as any,
    ...(prepay > 0n ? { value: prepay } : {}),
    query: { enabled: !!FACTORY_ADDRESS && !!args.name },
  })

  const effective = effectiveBlocks(data.tuning.cadence, epochFloor)

  const create = async () => {
    setFailure(null)
    setCreating(true)
    try {
      let gas: bigint | undefined
      try {
        const estimate = await publicClient?.estimateContractGas({
          address: FACTORY_ADDRESS,
          abi: trustGraphFactoryAbi,
          functionName: 'createInstance',
          args: [args] as any,
          ...(prepay > 0n ? { value: prepay } : {}),
        })
        gas = estimate ? (estimate * 125n) / 100n : undefined
      } catch {
        // Fall back to the wallet's own estimate.
      }

      const [receipt] = await txToast({
        tx: {
          address: FACTORY_ADDRESS,
          abi: trustGraphFactoryAbi,
          functionName: 'createInstance',
          args: [args],
          ...(gas ? { gas } : {}),
          ...(prepay > 0n ? { value: prepay } : {}),
        } as any,
        successMessage: 'Your network is live!',
      })

      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== FACTORY_ADDRESS.toLowerCase()) {
          continue
        }
        try {
          const decoded = decodeEventLog({
            abi: trustGraphFactoryAbi,
            data: log.data,
            topics: log.topics,
          })
          if (decoded.eventName !== 'InstanceCreated') {
            continue
          }
          const eventArgs = decoded.args as any
          onCreated({
            instanceId: eventArgs.instanceId as Hex,
            snapshot: eventArgs.snapshot as Hex,
            resolver: eventArgs.resolver as Hex,
            distributor: (eventArgs.distributor ?? zeroAddress) as Hex,
            epochBlocks: BigInt(eventArgs.epochLength ?? effective),
            name: (eventArgs.name as string) || args.name,
          })
          return
        } catch {
          // Not one of ours.
        }
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
        lead="One transaction creates everything: the place vouches are recorded, your network's own scoreboard, and the publishing schedule. You end up in charge of all of it."
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
                {seed}
              </div>
            ))}
          </div>
        </SummaryRow>
        <SummaryRow label="Scores published">
          {describeBlocks(effective)}
        </SummaryRow>
        <SummaryRow label="Shared fund">{fundSummary}</SummaryRow>
        <SummaryRow label="In charge afterwards">
          <span className="font-mono text-xs">{args.admin}</span>
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
