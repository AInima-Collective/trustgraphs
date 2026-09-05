'use client'

import { ArrowLeft, ArrowRight, LoaderCircle } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Hex, zeroAddress } from 'viem'
import { useAccount, useChainId, useReadContract } from 'wagmi'

import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { DraftNotice } from '@/components/DraftNotice'
import { WalletConnectionButton } from '@/components/WalletConnectionButton'
import { useWalletConnectionContext } from '@/components/WalletConnectionProvider'
import { useBrowserDraft } from '@/hooks/useBrowserDraft'
import { SUBNETWORK_CONFIG } from '@/lib/config'
import { trustgraphsFactoryAbi } from '@/lib/contract-abis'
import { parseFinancialAmount } from '@/lib/financial-state'
import { cn } from '@/lib/utils'
import { getTargetChainConfig, getTargetChainId } from '@/lib/wagmi'

import { parseCreationDraft } from './draft'
import {
  EMPTY_WIZARD_DATA,
  FACTORY_ADDRESS,
  WIZARD_STEPS,
  WizardData,
  buildCreateArgs,
  fundTokenProblem,
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

type CreateNetworkWizardProps = {
  parentInstanceId?: Hex
  parentNetworkId?: string
}

export const CreateNetworkWizard = (props: CreateNetworkWizardProps) => (
  <ScopedCreateNetworkWizard
    key={`${getTargetChainId()}:${props.parentInstanceId?.toLowerCase() ?? 'standard'}`}
    {...props}
  />
)

const ScopedCreateNetworkWizard = ({
  parentInstanceId,
  parentNetworkId,
}: CreateNetworkWizardProps) => {
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

  const [salt, setSalt] = useState<Hex>(() => randomSalt())
  const contentRef = useRef<HTMLDivElement>(null)
  const previousStep = useRef(step)
  const draft = useBrowserDraft({
    storageKey: `trustgraphs:create:${getTargetChainId()}:${parentInstanceId ?? 'standard'}:v1`,
    value: { step, data, salt },
    parse: parseCreationDraft,
    meaningful: !!(
      data.name ||
      data.description ||
      data.criteria ||
      data.seeds.length
    ),
    completed: !!created,
    onRestore: (saved) => {
      setData(saved.data)
      setSalt(saved.salt)
      // Metadata URIs and readiness are revalidated, never restored as trusted state.
      setPinned(null)
      setShowErrors(false)
      setStep(0)
      requestAnimationFrame(() =>
        contentRef.current
          ?.querySelector<HTMLElement>('[data-step-heading]')
          ?.focus()
      )
    },
  })
  useEffect(() => {
    if (previousStep.current === step) return
    previousStep.current = step
    const heading = contentRef.current?.querySelector<HTMLElement>(
      '[data-step-heading]'
    )
    heading?.focus({ preventScroll: true })
    heading?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }, [step])
  const creationFactoryAddress = ((parentInstanceId
    ? SUBNETWORK_CONFIG?.factory
    : FACTORY_ADDRESS) || '') as Hex

  const { data: epochFloorRead } = useReadContract({
    chainId: getTargetChainId(),
    address: creationFactoryAddress,
    abi: trustgraphsFactoryAbi,
    functionName: 'EPOCH_FLOOR',
    query: { enabled: creationFactoryAddress?.length === 42 },
  })
  const epochFloor = (epochFloorRead as bigint | undefined) ?? 0n
  const { data: vaultRead } = useReadContract({
    chainId: getTargetChainId(),
    address: creationFactoryAddress,
    abi: trustgraphsFactoryAbi,
    functionName: 'VAULT',
    query: { enabled: creationFactoryAddress?.length === 42 },
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
      return (
        prepayProblem(data) || parseFinancialAmount(data.prepayEth, 18).error
      )
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
      requestAnimationFrame(() => {
        const invalid = contentRef.current?.querySelector<HTMLElement>(
          '[aria-invalid="true"], [data-field-error] input, [data-field-error] button'
        )
        const target =
          invalid ??
          contentRef.current?.querySelector<HTMLElement>('[data-step-heading]')
        target?.focus({ preventScroll: true })
        target?.scrollIntoView({ block: 'center', behavior: 'instant' })
      })
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
    <div ref={contentRef} className="space-y-8 max-w-3xl min-w-0">
      <div className="space-y-4">
        <div className="space-y-1">
          <h1 className="text-2xl">
            {parentInstanceId
              ? 'Create a standard sub-network'
              : 'Create a standard network'}
          </h1>
          {parentInstanceId ? (
            <Link
              href={`/networks/${parentNetworkId ?? parentInstanceId}/subnetworks`}
              className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Back to parent network
            </Link>
          ) : (
            <Link
              href="/create"
              className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Choose a different kind of network
            </Link>
          )}
        </div>

        <div className="flex flex-row flex-wrap gap-x-4 gap-y-1">
          {WIZARD_STEPS.map(({ id, label }, index) => (
            <button
              key={id}
              type="button"
              // Going back is always safe; going forward has to pass each screen in turn.
              disabled={index > step}
              aria-current={index === step ? 'step' : undefined}
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

      <DraftNotice
        pending={!!draft.pending}
        status={draft.status}
        onRestore={draft.restore}
        onDiscard={draft.discard}
      />

      {!isConnected && (
        <Card type="outline" size="md" className="space-y-3">
          <p className="text-sm">
            {parentInstanceId
              ? 'Connect a wallet to prepare the creation action. The parent network’s members decide whether to pass it through their governance process.'
              : 'Prepare your network below. Connect a wallet when you are ready to review and create it. Members will govern the network through its shared Safe.'}
          </p>
          <WalletConnectionButton />
        </Card>
      )}

      {wrongChain && (
        <Card type="outline" size="md" className="space-y-3">
          <p className="text-sm">
            Your wallet is on a different network. Switch it to{' '}
            {getTargetChainConfig().name} before creating the network.
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
        <>
          <TuningStep
            data={data}
            onChange={onChange}
            epochFloor={epochFloor}
            showErrors={showErrors}
            vaultAvailable={vaultAvailable}
          />
          {showErrors &&
            vaultAvailable &&
            !prepayProblem(data) &&
            parseFinancialAmount(data.prepayEth, 18).error && (
              <p role="alert" className="text-sm text-destructive">
                {parseFinancialAmount(data.prepayEth, 18).error}
              </p>
            )}
          {!vaultAvailable && data.prepayEth.trim() && (
            <Card type="outline" size="md" className="space-y-3">
              <p role="status" className="text-sm">
                This draft includes a proof prepayment. Funding availability
                could not be verified yet. You can remove it and continue, or
                keep it for the pricing checks on review.
              </p>
              {showErrors && stepProblem(step) && (
                <p role="alert" className="text-sm text-destructive">
                  {stepProblem(step)}
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={() => onChange({ prepayEth: '' })}
              >
                Remove saved prepayment
              </Button>
            </Card>
          )}
        </>
      )}
      {stepId === 'extras' && (
        <AddOnsStep
          data={data}
          onChange={onChange}
          showErrors={showErrors}
          parentInstanceId={parentInstanceId}
        />
      )}
      {stepId === 'review' && (
        <ReviewStep
          data={data}
          args={args}
          epochFloor={epochFloor}
          metadataUri={metadataUri}
          parentInstanceId={parentInstanceId}
          parentNetworkId={parentNetworkId}
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
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
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
            disabled={pinning || !draft.ready || !!draft.pending}
            className="min-w-0 max-w-full h-auto min-h-11 whitespace-normal py-2"
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
