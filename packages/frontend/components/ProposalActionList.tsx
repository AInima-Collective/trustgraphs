'use client'

import {
  Code2,
  FilePenLine,
  PauseCircle,
  Send,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { formatEther } from 'viem'

import { useNetwork } from '@/contexts/NetworkContext'
import {
  governanceActionContextFor,
  normalizeSafeActions,
  walkGovernanceActions,
} from '@/lib/actions'
import type {
  EthTransferActionValues,
  MatchedGovernanceAction,
  NetworkProfileActionValues,
  SafeAction,
  ScoringParamsActionValues,
  SignerParamsActionValues,
  SignerPauseActionValues,
  WeightedPriorRotationActionValues,
} from '@/lib/actions'
import { paramsHash } from '@/lib/pagerank/encode'
import { formatFixed } from '@/lib/scoring-params'
import { cn } from '@/lib/utils'

import { Card } from './Card'
import { CopyableText } from './CopyableText'

export type DisplayProposalAction = SafeAction & {
  contractName?: string
  functionSignature?: string
}

type ActionKind =
  | 'signer-sync'
  | 'signer-pause'
  | 'scoring-update'
  | 'weighted-prior'
  | 'network-profile'
  | 'transfer'
  | 'custom'

type ActionPresentation = {
  kind: ActionKind
  title: string
  summary: string
  badge: string
  icon: ComponentType<{ className?: string }>
  hash?: string
  evidenceURI?: string
  resultingSettings?: string[]
  coordinated?: boolean
  detailLabel?: string
  detailValue?: string
}

const presentAction = (
  matched: MatchedGovernanceAction
): ActionPresentation => {
  switch (matched.definition.key) {
    case 'update-scoring-params': {
      const values = matched.values as ScoringParamsActionValues
      return {
        kind: 'scoring-update',
        title: 'Publish the new scoring configuration',
        summary: values.syncSigner
          ? 'Synchronize signer selection and publish these settings together as the network’s next version.'
          : 'Make these settings the network’s current, versioned scoring configuration.',
        badge: 'Scoring settings',
        icon: SlidersHorizontal,
        hash: paramsHash(values.proposed),
        evidenceURI: values.evidenceURI,
        resultingSettings: [
          `Damping: ${formatFixed(values.proposed.dampingFp)}`,
          `Trusted accounts: ${values.proposed.trustedSeeds.length}`,
          `Maximum iterations: ${values.proposed.maxIterations}`,
        ],
        coordinated: values.syncSigner,
      }
    }
    case 'set-signer-params-hash': {
      const values = matched.values as SignerParamsActionValues
      return {
        kind: 'signer-sync',
        title: 'Synchronize signer rules',
        summary:
          'Point the signer-selection module at the new scoring configuration.',
        badge: 'Signer rules',
        icon: ShieldCheck,
        hash: values.paramsHash,
      }
    }
    case 'send-eth': {
      const values = matched.values as EthTransferActionValues
      return {
        kind: 'transfer',
        title: `Send ${formatEther(BigInt(values.value))} ETH`,
        summary: 'Transfer ETH from the DAO treasury.',
        badge: 'Treasury transfer',
        icon: Send,
      }
    }
    case 'update-network-profile': {
      const values = matched.values as NetworkProfileActionValues
      return {
        kind: 'network-profile',
        title: 'Publish a new network profile',
        summary:
          'Point the network snapshot at the reviewed metadata revision.',
        badge: 'Network profile',
        icon: FilePenLine,
        detailLabel: 'New metadata URI',
        detailValue: values.metadataURI,
      }
    }
    case 'set-signer-sync-paused': {
      const values = matched.values as SignerPauseActionValues
      return {
        kind: 'signer-pause',
        title: `${values.paused ? 'Pause' : 'Resume'} signer synchronization`,
        summary: values.paused
          ? 'Stop new score-selected signer proofs while retaining the current Safe owners.'
          : 'Allow new score-selected signer proofs to update the Safe owners again.',
        badge: 'Safety control',
        icon: PauseCircle,
      }
    }
    case 'rotate-weighted-prior': {
      const values = matched.values as WeightedPriorRotationActionValues
      return {
        kind: 'weighted-prior',
        title: 'Change weighted starting shares',
        summary:
          'Propose a reviewed weighted-prior manifest for delayed activation.',
        badge: 'Scoring settings',
        icon: SlidersHorizontal,
        detailLabel: 'Manifest metadata digest',
        detailValue: values.metadataDigest,
      }
    }
    default: {
      const action = matched.actions[0]
      return {
        kind: 'custom',
        title: 'Execute a contract call',
        summary:
          'This action is not recognized by trustgraphs. Review its raw target, value, operation, and calldata.',
        badge: action?.operation === 1 ? 'Delegate call' : 'Contract call',
        icon: Code2,
      }
    }
  }
}

const formatOperation = (operation: SafeAction['operation']) =>
  operation === 1 ? 'DELEGATECALL' : 'CALL'

const actionValue = (value: string) => {
  try {
    return BigInt(value)
  } catch {
    return 0n
  }
}

function TechnicalActionDetails({
  actions,
}: {
  actions: readonly DisplayProposalAction[]
}) {
  return (
    <details className="border-t border-border pt-1">
      <summary className="min-h-11 cursor-pointer py-3 text-xs font-medium text-muted-foreground hover:text-foreground">
        Technical transaction details
      </summary>
      <div className="space-y-4 border-t border-border pt-3 text-xs">
        {actions.map((action, index) => {
          const value = actionValue(action.value)
          const contractCall =
            action.contractName && action.functionSignature
              ? `${action.contractName}.${action.functionSignature}`
              : null
          return (
            <div
              key={`${action.target}:${index}`}
              className="space-y-3 border-b border-border pb-4 last:border-0 last:pb-0"
            >
              {actions.length > 1 && (
                <p className="font-medium text-foreground">
                  Transaction {index + 1} of {actions.length}
                </p>
              )}
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-muted-foreground">
                <span>{formatOperation(action.operation)}</span>
                <span>
                  {value === 0n ? '0 ETH' : `${formatEther(value)} ETH`}
                </span>
              </div>
              {contractCall && (
                <div className="space-y-1">
                  <p className="text-muted-foreground">Contract function</p>
                  <p className="break-words font-mono text-foreground">
                    {contractCall}
                  </p>
                </div>
              )}
              <div className="space-y-1">
                <p className="text-muted-foreground">Target contract</p>
                <CopyableText
                  text={action.target}
                  truncate
                  alwaysShowCopyIcon
                  className="max-w-full"
                />
              </div>
              {action.data !== '0x' && (
                <div className="space-y-2">
                  <p className="text-muted-foreground">Encoded calldata</p>
                  <CopyableText
                    text={action.data}
                    displayText="Copy full calldata"
                    truncate={false}
                    truncateOnMobile={false}
                    alwaysShowCopyIcon
                  />
                  <p className="max-h-32 overflow-auto break-all font-mono text-muted-foreground">
                    {action.data}
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </details>
  )
}

function ProposalActionCard({
  matched,
  actions,
  index,
  total,
}: {
  matched: MatchedGovernanceAction
  actions: readonly DisplayProposalAction[]
  index: number
  total: number
}) {
  const presentation = presentAction(matched)
  const Icon = presentation.icon
  const annotations = actions
    .map((action) => action.description?.trim())
    .filter((description): description is string => !!description)

  return (
    <Card type="accent" size="md" className="min-w-0 space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-border bg-surface text-foreground">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="tg-label">
              Action {index + 1} of {total}
            </p>
            <span className="border border-border bg-surface px-2 py-1 text-xs text-muted-foreground">
              {presentation.badge}
            </span>
          </div>
          <h4 className="mt-2 text-base font-semibold text-foreground">
            {presentation.title}
          </h4>
          <p className="mt-1 text-sm text-muted-foreground">
            {presentation.summary}
          </p>
        </div>
      </div>

      {presentation.resultingSettings && (
        <div className="border-l-2 border-foreground/30 bg-surface px-3 py-2">
          <p className="text-xs font-medium text-foreground">
            Resulting settings
          </p>
          <ul className="mt-2 grid gap-1 text-sm text-foreground/80 sm:grid-cols-2">
            {presentation.resultingSettings.map((setting) => (
              <li key={setting}>{setting}</li>
            ))}
          </ul>
        </div>
      )}

      {presentation.hash && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {presentation.kind === 'signer-sync'
              ? 'Configuration to use'
              : 'New configuration ID'}
          </p>
          <CopyableText
            text={presentation.hash}
            truncate
            alwaysShowCopyIcon
            className="max-w-full text-foreground"
          />
        </div>
      )}

      {presentation.evidenceURI && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Supporting evidence</p>
          <CopyableText
            text={presentation.evidenceURI}
            truncate
            alwaysShowCopyIcon
            className="max-w-full"
          />
        </div>
      )}

      {presentation.detailValue && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {presentation.detailLabel}
          </p>
          <CopyableText
            text={presentation.detailValue}
            truncate
            alwaysShowCopyIcon
            className="max-w-full"
          />
        </div>
      )}

      {annotations.length > 0 && (
        <div className="border border-border bg-surface-2 px-3 py-2">
          <p className="text-xs font-medium text-foreground">
            Proposer annotation
          </p>
          {annotations.map((annotation, annotationIndex) => (
            <p
              key={`${annotation}:${annotationIndex}`}
              className="mt-1 break-words text-xs text-muted-foreground"
            >
              {annotation}
            </p>
          ))}
        </div>
      )}

      <TechnicalActionDetails actions={actions} />
    </Card>
  )
}

export function ProposalActionList({
  actions,
  className,
}: {
  actions: readonly DisplayProposalAction[]
  className?: string
}) {
  const { network } = useNetwork()
  const normalized = normalizeSafeActions(actions)
  if (!normalized.ok) {
    return (
      <div
        className={cn(
          'border border-destructive/50 bg-destructive/10 p-4 text-sm',
          className
        )}
        role="alert"
      >
        <p className="font-medium text-foreground">
          Action details unavailable
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {normalized.reason} No transaction details were inferred from the
          malformed payload.
        </p>
      </div>
    )
  }
  const displayActions = normalized.actions.map((action, index) => ({
    ...action,
    ...(actions[index]?.contractName
      ? { contractName: actions[index].contractName }
      : {}),
    ...(actions[index]?.functionSignature
      ? { functionSignature: actions[index].functionSignature }
      : {}),
  }))
  const context = governanceActionContextFor(network)
  const matched = walkGovernanceActions(displayActions, context)
  const coordinatedScoringUpdate = matched.some(
    (entry) => presentAction(entry).coordinated
  )

  return (
    <div className={cn('space-y-3', className)}>
      {coordinatedScoringUpdate && (
        <div className="border border-success/40 bg-success-soft p-4">
          <p className="text-sm font-medium text-foreground">
            One coordinated scoring update
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            These consecutive calls use the same configuration ID and execute
            together. The signer rules are synchronized before the complete
            settings are published as the next version.
          </p>
        </div>
      )}
      <ol className="space-y-3">
        {matched.map((entry, index) => (
          <li key={`${entry.definition.key}:${entry.startIndex}`}>
            <ProposalActionCard
              matched={entry}
              actions={displayActions.slice(
                entry.startIndex,
                entry.startIndex + entry.consumed
              )}
              index={index}
              total={matched.length}
            />
          </li>
        ))}
      </ol>
    </div>
  )
}
