'use client'

import { ArrowLeft, ArrowRight, LoaderCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Hex, zeroAddress } from 'viem'
import { useAccount, useChainId, useReadContract, useSwitchChain } from 'wagmi'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { WalletConnectionButton } from '@/components/WalletConnectionButton'
import { trustGraphFactoryAbi } from '@/lib/contract-abis'
import { cn } from '@/lib/utils'
import { getTargetChainConfig, getTargetChainId } from '@/lib/wagmi'

import {
  EMPTY_WIZARD_DATA,
  FACTORY_ADDRESS,
  WizardData,
  buildCreateArgs,
  fundTokenProblem,
  isFactoryAvailable,
  metadataFingerprint,
  metadataFrom,
  nameProblem,
  randomSalt,
  urlProblem,
} from './model'
import { pinMetadata } from './pin'
import { AddOnsStep } from './steps/AddOnsStep'
import { IdentityStep } from './steps/IdentityStep'
import { CreatedNetwork, ReviewStep } from './steps/ReviewStep'
import { SeedsStep } from './steps/SeedsStep'
import { SuccessStep } from './steps/SuccessStep'
import { TuningStep } from './steps/TuningStep'
import { Note } from './ui'

const STEPS = [
  'Description',
  'Starting accounts',
  'Scoring',
  'Extras',
  'Review',
]

export const CreateNetworkWizard = () => {
  const { isConnected } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: switching } = useSwitchChain()

  const [step, setStep] = useState(0)
  const [showErrors, setShowErrors] = useState(false)
  const [data, setData] = useState<WizardData>(EMPTY_WIZARD_DATA)
  const [created, setCreated] = useState<CreatedNetwork | null>(null)

  const [pinning, setPinning] = useState(false)
  const [pinError, setPinError] = useState<string | null>(null)
  const [pinned, setPinned] = useState<{
    uri: string
    fingerprint: string
  } | null>(null)

  const [salt] = useState<Hex>(() => randomSalt())

  const { data: epochFloorRead } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: trustGraphFactoryAbi,
    functionName: 'EPOCH_FLOOR',
    query: { enabled: isFactoryAvailable() },
  })
  const epochFloor = (epochFloorRead as bigint | undefined) ?? 0n

  const onChange = (patch: Partial<WizardData>) => {
    setData((current) => ({ ...current, ...patch }))
    setShowErrors(false)
  }

  const metadata = useMemo(() => metadataFrom(data), [data])
  const fingerprint = metadataFingerprint(metadata)
  const metadataUri = pinned?.fingerprint === fingerprint ? pinned.uri : ''

  const args = useMemo(
    () =>
      buildCreateArgs({
        data,
        metadataURI: metadataUri,
        // GovernedTrustGraphFactory replaces this with the new DAO Safe. Keeping zero here makes
        // it impossible for review copy or a future caller to mistake the connected EOA for the
        // lasting network authority.
        admin: zeroAddress as Hex,
        epochFloor,
        salt,
      }),
    [data, metadataUri, epochFloor, salt]
  )

  /** What is stopping the person leaving the step they are on. */
  const stepProblem = (index: number): string | null => {
    if (index === 0) {
      return (
        nameProblem(data.name) ||
        urlProblem(data.image) ||
        urlProblem(data.applicationUrl)
      )
    }
    if (index === 1) {
      return data.seeds.length ? null : 'Add at least one starting account.'
    }
    if (index === 3) {
      return fundTokenProblem(data)
    }
    return null
  }

  const savePresentation = async (): Promise<boolean> => {
    if (pinned?.fingerprint === fingerprint) {
      return true
    }
    setPinning(true)
    setPinError(null)
    try {
      const { uri } = await pinMetadata(metadata)
      setPinned({ uri, fingerprint })
      return true
    } catch (error: any) {
      setPinError(error?.message || 'Could not save the description.')
      return false
    } finally {
      setPinning(false)
    }
  }

  const next = async () => {
    if (stepProblem(step)) {
      setShowErrors(true)
      return
    }
    if (step === 0 && !(await savePresentation())) {
      return
    }
    setShowErrors(false)
    setStep((current) => Math.min(current + 1, STEPS.length - 1))
  }

  const back = () => {
    setShowErrors(false)
    setStep((current) => Math.max(current - 1, 0))
  }

  const skipPinning = () => {
    setPinned({ uri: '', fingerprint })
    setPinError(null)
    setStep(1)
  }

  if (created) {
    return <SuccessStep created={created} />
  }

  if (!isFactoryAvailable()) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl">Create a network</h1>
        <Card type="outline" size="md">
          <p className="text-sm">
            Networks cannot be created on {getTargetChainConfig().name} yet.
          </p>
        </Card>
      </div>
    )
  }

  const wrongChain = isConnected && chainId !== getTargetChainId()

  return (
    <div className="space-y-8 max-w-3xl">
      <div className="space-y-4">
        <h1 className="text-2xl">Create a network</h1>

        <div className="flex flex-row flex-wrap gap-x-4 gap-y-1">
          {STEPS.map((label, index) => (
            <button
              key={label}
              type="button"
              // Going back is always safe; going forward has to pass each screen in turn.
              disabled={index > step}
              onClick={() => {
                setShowErrors(false)
                setStep(index)
              }}
              className={cn(
                'text-xs transition-opacity',
                index === step
                  ? 'opacity-100'
                  : index < step
                    ? 'opacity-50 hover:opacity-80'
                    : 'opacity-30 cursor-default'
              )}
            >
              {index + 1}. {label}
            </button>
          ))}
        </div>
      </div>

      {!isConnected && (
        <Card type="outline" size="md" className="space-y-3">
          <p className="text-sm">
            Connect the wallet that will create this network and become the DAO
            Safe&apos;s initial signer. The Safe—not this wallet—will own the
            network contracts.
          </p>
          <WalletConnectionButton />
        </Card>
      )}

      {wrongChain && (
        <Card type="outline" size="md" className="space-y-3">
          <p className="text-sm">
            Your wallet is on a different network. Switch it to{' '}
            {getTargetChainConfig().name} to carry on.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={switching}
            onClick={() => switchChain({ chainId: getTargetChainId() })}
          >
            Switch to {getTargetChainConfig().name}
          </Button>
        </Card>
      )}

      {step === 0 && (
        <IdentityStep data={data} onChange={onChange} showErrors={showErrors} />
      )}
      {step === 1 && (
        <SeedsStep data={data} onChange={onChange} showErrors={showErrors} />
      )}
      {step === 2 && (
        <TuningStep data={data} onChange={onChange} epochFloor={epochFloor} />
      )}
      {step === 3 && (
        <AddOnsStep data={data} onChange={onChange} showErrors={showErrors} />
      )}
      {step === 4 && (
        <ReviewStep
          data={data}
          args={args}
          epochFloor={epochFloor}
          metadataUri={metadataUri}
          onCreated={setCreated}
          onSeedsChanged={(seeds, seedNames) => onChange({ seeds, seedNames })}
          onJumpTo={(index) => {
            setShowErrors(false)
            setStep(index)
          }}
        />
      )}

      {pinError && step === 0 && (
        <Card type="outline" size="md" className="border-destructive space-y-3">
          <p className="text-sm text-destructive">{pinError}</p>
          <Note>
            Your network will still work without it: the page just shows the
            name until a description is added later.
          </Note>
          <div className="flex flex-row flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={next}>
              Try again
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={skipPinning}
            >
              Carry on without it
            </Button>
          </div>
        </Card>
      )}

      {step < STEPS.length - 1 && (
        <div className="flex flex-row items-center gap-2 pt-2 border-t border-border">
          <Button
            type="button"
            variant="ghost"
            onClick={back}
            disabled={step === 0}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button
            type="button"
            onClick={next}
            disabled={!isConnected || wrongChain || pinning}
          >
            {pinning && <LoaderCircle className="h-4 w-4 animate-spin" />}
            {pinning ? 'Saving your description...' : 'Continue'}
            {!pinning && <ArrowRight className="h-4 w-4" />}
          </Button>
        </div>
      )}

      {step === STEPS.length - 1 && (
        <div className="pt-2 border-t border-border">
          <Button type="button" variant="ghost" onClick={back}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        </div>
      )}
    </div>
  )
}
