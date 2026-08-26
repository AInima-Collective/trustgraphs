'use client'

import { ArrowLeft, ArrowRight, LoaderCircle } from 'lucide-react'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { Hex, zeroAddress } from 'viem'
import { useAccount, useChainId, useReadContract } from 'wagmi'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { WalletConnectionButton } from '@/components/WalletConnectionButton'
import { useWalletConnectionContext } from '@/components/WalletConnectionProvider'
import { trustgraphsFactoryAbi } from '@/lib/contract-abis'
import { cn } from '@/lib/utils'
import { getTargetChainConfig, getTargetChainId } from '@/lib/wagmi'

import {
  EMPTY_WIZARD_DATA,
  FACTORY_ADDRESS,
  WIZARD_STEPS,
  WizardData,
  buildCreateArgs,
  fundTokenProblem,
  isFactoryAvailable,
  metadataFingerprint,
  metadataFrom,
  nameProblem,
  offchainVouchesProblem,
  prepayProblem,
  randomSalt,
  signerSyncProblem,
  urlProblem,
  wizardStepIndex,
} from './model'
import { pinMetadata } from './pin'
import { AddOnsStep } from './steps/AddOnsStep'
import { IdentityStep } from './steps/IdentityStep'
import { CreatedNetwork, ReviewStep } from './steps/ReviewStep'
import { SeedsStep } from './steps/SeedsStep'
import { SuccessStep } from './steps/SuccessStep'
import { TuningStep } from './steps/TuningStep'
import { Note } from './ui'

export const CreateNetworkWizard = () => {
  const { isConnected } = useAccount()
  const chainId = useChainId()
  const { switchToTarget, switchingTarget } = useWalletConnectionContext()

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
    abi: trustgraphsFactoryAbi,
    functionName: 'EPOCH_FLOOR',
    query: { enabled: isFactoryAvailable() },
  })
  const epochFloor = (epochFloorRead as bigint | undefined) ?? 0n
  const { data: vaultRead } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: trustgraphsFactoryAbi,
    functionName: 'VAULT',
    query: { enabled: isFactoryAvailable() },
  })
  const vaultAvailable =
    typeof vaultRead === 'string' &&
    vaultRead.toLowerCase() !== zeroAddress.toLowerCase()

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
        // GovernedTrustgraphsFactory replaces this with the new DAO Safe. Keeping zero here makes
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
    const id = WIZARD_STEPS[index]?.id
    if (id === 'description') {
      return (
        nameProblem(data.name) ||
        urlProblem(data.image) ||
        urlProblem(data.applicationUrl)
      )
    }
    if (id === 'accounts') {
      return data.seeds.length ? null : 'Add at least one starting account.'
    }
    if (id === 'scoring') {
      return vaultAvailable ? prepayProblem(data) : null
    }
    if (id === 'extras') {
      return (
        fundTokenProblem(data) ||
        offchainVouchesProblem(data) ||
        signerSyncProblem(data)
      )
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
    if (
      WIZARD_STEPS[step]?.id === 'description' &&
      !(await savePresentation())
    ) {
      return
    }
    setShowErrors(false)
    setStep((current) => Math.min(current + 1, WIZARD_STEPS.length - 1))
  }

  const back = () => {
    setShowErrors(false)
    setStep((current) => Math.max(current - 1, 0))
  }

  const skipPinning = () => {
    setPinned({ uri: '', fingerprint })
    setPinError(null)
    setStep(wizardStepIndex('accounts'))
  }

  if (created) {
    return <SuccessStep created={created} />
  }

  const wrongChain = isConnected && chainId !== getTargetChainId()
  const stepId = WIZARD_STEPS[step]?.id

  return (
    <div className="space-y-8 max-w-3xl">
      <div className="space-y-4">
        <div className="space-y-1">
          <h1 className="text-2xl">Create a standard network</h1>
          <Link
            href="/create"
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Choose a different kind of network
          </Link>
        </div>

        <div className="flex flex-row flex-wrap gap-x-4 gap-y-1">
          {WIZARD_STEPS.map(({ id, label }, index) => (
            <button
              key={id}
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
            Safe&apos;s visible owner and delayed recovery proposer. A sealed
            guard disables owner-signed execution; members govern the Safe, and
            the Safe, not this wallet, owns the network contracts.
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
            disabled={switchingTarget}
            onClick={() => void switchToTarget()}
          >
            Switch to {getTargetChainConfig().name}
          </Button>
        </Card>
      )}

      {stepId === 'description' && (
        <IdentityStep data={data} onChange={onChange} showErrors={showErrors} />
      )}
      {stepId === 'accounts' && (
        <SeedsStep data={data} onChange={onChange} showErrors={showErrors} />
      )}
      {stepId === 'scoring' && (
        <TuningStep
          data={data}
          onChange={onChange}
          epochFloor={epochFloor}
          showErrors={showErrors}
          vaultAvailable={vaultAvailable}
        />
      )}
      {stepId === 'extras' && (
        <AddOnsStep data={data} onChange={onChange} showErrors={showErrors} />
      )}
      {stepId === 'review' && (
        <ReviewStep
          data={data}
          args={args}
          epochFloor={epochFloor}
          metadataUri={metadataUri}
          onCreated={setCreated}
          onSeedsChanged={(seeds, seedNames) => onChange({ seeds, seedNames })}
          onJumpTo={(id) => {
            setShowErrors(false)
            setStep(wizardStepIndex(id))
          }}
        />
      )}

      {pinError && stepId === 'description' && (
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

      {step < WIZARD_STEPS.length - 1 && (
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

      {step === WIZARD_STEPS.length - 1 && (
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
